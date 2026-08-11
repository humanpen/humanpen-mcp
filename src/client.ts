import { readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';

/**
 * A failure the model should be able to act on.
 *
 * `retryable` is the part that matters: an agent that cannot tell a rate
 * limit from an empty wallet either gives up on both or retries both, and
 * retrying an empty wallet is just noise.
 */
export class HumanPenError extends Error {
  constructor(
    message: string,
    readonly code: string = '',
    readonly retryable: boolean = false,
  ) {
    super(message);
    this.name = 'HumanPenError';
  }
}

export type JobFile = {
  file_id: string;
  filename: string | null;
  words: number | null;
  available: boolean;
  retained_until: string | null;
  download_url?: string;
  download_url_expires_at?: string | null;
};

export type Job = {
  job_id: string;
  operation: string;
  status: string;
  finished: boolean;
  progress_percent: number;
  source: JobFile | null;
  result: JobFile | null;
  credits: { frozen: number; charged: number | null };
  error: { code: string | null; message: string | null } | null;
  created_at: string | null;
  started_at: string | null;
  finished_at: string | null;
};

export type JobReceipt = {
  job_id: string;
  operation: string;
  status: string;
  credits_frozen: number;
  created_at: string | null;
};

export type DetectionReport = {
  report_type: string | null;
  ai_percent: number | null;
  filename: string;
  page_count: number;
  segment_count: number;
  problem_type_counts: Record<string, number>;
  segments: Array<{ text: string; page_number: number; problem_types: string[] }>;
};

const DEFAULT_BASE_URL = 'https://api.humanpen.net/v1';
const KEYS_URL = 'https://humanpen.net/settings/api-keys';
const PRICING_URL = 'https://humanpen.net/pricing';

// Jobs take minutes. Start gentle and back off, which is what the API's own
// docs ask for; a tight loop only spends the caller's rate limit.
const POLL_FIRST_MS = 3_000;
const POLL_MAX_MS = 30_000;

// What the API accepts; checked here so the failure is a sentence rather than
// a heap exhaustion partway through the read.
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

export class HumanPenClient {
  private readonly baseUrl: string;

  constructor(private readonly apiKey: string, baseUrl?: string) {
    this.baseUrl = (baseUrl ?? process.env.HUMANPEN_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  }

  private async request<T>(method: string, path: string, body?: BodyInit): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        body,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          // Names this client in HumanPen's logs, which is where a support
          // question gets answered from.
          'User-Agent': 'humanpen-mcp/1.0',
        },
      });
    } catch (cause) {
      throw new HumanPenError(
        `cannot reach ${this.baseUrl}: ${cause instanceof Error ? cause.message : String(cause)}`,
        'NETWORK',
        true,
      );
    }

    const payload = (await response.json().catch(() => ({}))) as {
      code?: string;
      message?: string;
      data?: T;
    };
    if (!response.ok) {
      const code = payload.code ?? '';
      let message = payload.message ?? response.statusText;
      if (response.status === 401) message += ` - check HUMANPEN_API_KEY, or create one at ${KEYS_URL}`;
      if (response.status === 402) message += ` - top up at ${PRICING_URL}`;
      throw new HumanPenError(
        `HTTP ${response.status} ${code}: ${message}`,
        code,
        response.status === 429 || response.status >= 500,
      );
    }
    return (payload.data ?? payload) as T;
  }

  /** Build the multipart body for a job. */
  private async documentForm(
    documentPath: string,
    fields: Record<string, string | undefined>,
    reportPath?: string,
  ): Promise<FormData> {
    const form = new FormData();
    form.append('file', await this.filePart(documentPath));
    if (reportPath) form.append('turnitin_file', await this.filePart(reportPath));
    for (const [name, value] of Object.entries(fields)) {
      if (value !== undefined && value !== '') form.append(name, value);
    }
    return form;
  }

  /**
   * Read one file into a multipart part.
   *
   * Async rather than sync: this process is an agent's long-lived server, and
   * blocking its event loop on disk I/O stalls every other tool call. The
   * size is checked first so an oversized file is refused with a sentence
   * instead of an out-of-memory crash.
   */
  private async filePart(path: string): Promise<File> {
    let size: number;
    try {
      size = (await stat(path)).size;
    } catch {
      throw new HumanPenError(`no such file: ${path}`, 'FILE_NOT_FOUND');
    }
    if (size > MAX_UPLOAD_BYTES) {
      throw new HumanPenError(
        `${basename(path)} is ${(size / 1_048_576).toFixed(1)} MB; the limit is ` +
          `${MAX_UPLOAD_BYTES / 1_048_576} MB`,
        'FILE_TOO_LARGE',
      );
    }
    return new File([await readFile(path)], basename(path));
  }

  async createJob(
    operation: string,
    documentPath: string,
    fields: Record<string, string | undefined>,
    reportPath?: string,
  ): Promise<JobReceipt> {
    const form = await this.documentForm(documentPath, fields, reportPath);
    return this.request<JobReceipt>('POST', `/jobs/${operation}`, form);
  }

  /**
   * Continue a finished humanize job for free. No source file is uploaded - the
   * server clones the parent job's own result as the source - so only the fresh
   * report and optional fields (segments, instructions) ride along, POSTed to
   * the parent's free-rehumanize endpoint. Eligibility is entirely the server's.
   */
  async createFreeRehumanizeJob(
    parentJobId: string,
    reportPath: string,
    fields: Record<string, string | undefined>,
  ): Promise<JobReceipt> {
    const form = new FormData();
    form.append('turnitin_file', await this.filePart(reportPath));
    for (const [name, value] of Object.entries(fields)) {
      if (value !== undefined && value !== '') form.append(name, value);
    }
    return this.request<JobReceipt>('POST', `/jobs/${parentJobId}/free-rehumanize`, form);
  }

  async getJob(jobId: string): Promise<Job> {
    return this.request<Job>('GET', `/jobs/${jobId}`);
  }

  async parseReport(reportPath: string, type?: string): Promise<DetectionReport> {
    const form = new FormData();
    form.append('file', await this.filePart(reportPath));
    if (type) form.append('type', type);
    return this.request<DetectionReport>('POST', '/detect-reports/parse', form);
  }

  async getBalance(): Promise<Record<string, unknown>> {
    return this.request('GET', '/credits/balance');
  }

  /**
   * Wait for a job, but not forever.
   *
   * MCP clients time a tool call out after a minute or so while jobs run for
   * several, so this returns whatever is true when the budget runs out. A
   * caller that gets back an unfinished job is told to poll rather than left
   * holding a dead request.
   */
  async waitForJob(jobId: string, waitMs: number): Promise<Job> {
    const deadline = Date.now() + waitMs;
    let delay = POLL_FIRST_MS;
    let job: Job | undefined;
    for (;;) {
      try {
        job = await this.getJob(jobId);
      } catch (cause) {
        // A blip while polling says nothing about the job, which is running
        // on a server somewhere regardless. Abandoning the wait over one lost
        // packet would strand work the caller already paid for.
        if (!(cause instanceof HumanPenError && cause.retryable) || Date.now() >= deadline) throw cause;
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay = Math.min(delay * 2, POLL_MAX_MS);
        continue;
      }
      if (job.finished || Date.now() >= deadline) return job;
      await new Promise((resolve) => setTimeout(resolve, Math.min(delay, Math.max(0, deadline - Date.now()))));
      delay = Math.min(delay * 2, POLL_MAX_MS);
    }
  }

  /**
   * Save a finished job's result to disk and return where it landed.
   *
   * The document never passes through the model: the tool answers with a
   * path, which is the whole point - a 2 MB docx in a tool result is an
   * expensive way to say nothing.
   */
  async downloadResult(job: Job, sourcePath: string, outputPath?: string): Promise<string> {
    const url = job.result?.download_url;
    if (!url) throw new HumanPenError('the finished job carries no result file', 'NO_RESULT');

    // The API names the result after the document it came from, so there is
    // no second naming scheme here to keep in step with it.
    const defaultName = job.result?.filename ?? basename(sourcePath);
    let target: string;
    if (outputPath) {
      const isDirectory = await stat(outputPath).then((s) => s.isDirectory()).catch(() => false);
      target = isDirectory ? join(outputPath, defaultName) : outputPath;
    } else {
      target = join(dirname(sourcePath), defaultName);
    }

    // A presigned link: a plain GET, no Authorization header, short-lived.
    const response = await fetch(url);
    if (!response.ok) {
      throw new HumanPenError(
        `downloading the result failed with HTTP ${response.status}`,
        'DOWNLOAD_FAILED',
        true,
      );
    }
    await writeFile(target, Buffer.from(await response.arrayBuffer()));
    return target;
  }
}
