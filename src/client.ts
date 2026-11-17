import { open, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

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

/** A page of the account's jobs, newest first (GET /jobs). */
export type JobList = { items: Job[]; total: number; limit: number; offset: number; has_more: boolean };

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

/** Where one input file of a research project goes: one signed PUT, or numbered parts of a large one. */
export type ProjectUploadTarget =
  | { method: 'PUT'; url: string; headers?: Record<string, string> }
  | { method: 'MULTIPART'; upload_id: string; part_size: number; parts: Array<{ number: number; url: string }> };

export type ProjectUpload = { name: string; target: ProjectUploadTarget };

/** A research project as the API gives it (docs.md, "Research projects"). */
export type Project = {
  id: string;
  title: string | null;
  state: string;
  stage: string | null;
  /** While input_required: what the user does next (send_request, answer_questions, confirm_or_revise_plan,
   * accept_or_retry, top_up, resume, rephrase) and what doing it takes. */
  required_input: ({ type: string; pause_id?: string } & Record<string, unknown>) | null;
  queue_position?: number | null;
  retry_at?: string | null;
  allowed_actions: Array<{ action: string } & Record<string, unknown>>;
  activity?: { kind?: string; description?: string } | null;
  progress?: Array<{ text?: string; status?: string }> | null;
  question?: Record<string, unknown> | null;
  spec_version?: number | null;
  spec?: Record<string, unknown> | null;
  estimate_minutes?: number[] | null;
  delivered_version?: number | null;
  autonomy?: { confirm_plan: string; answer: string; max_credits: number } | null;
  billing?: Record<string, unknown>;
  consumed_credits?: number | null;
  deletes_at?: string | null;
};

export type ProjectEvent = { seq: number; type: string; data: Record<string, unknown>; created_at: string | null };

export type ProjectDelivery = { version: number; files: number; bytes: number; created_at: string | null };

const DEFAULT_BASE_URL = 'https://api.humanpen.net/v1';
const KEYS_URL = 'https://humanpen.net/settings/api-keys';
const PRICING_URL = 'https://humanpen.net/pricing';

// Jobs take minutes. Start gentle and back off, which is what the API's own
// docs ask for; a tight loop only spends the caller's rate limit.
const POLL_FIRST_MS = 3_000;
const POLL_MAX_MS = 30_000;

// A project that answers for its user (autonomy) shows a wait for a few seconds before HumanPen answers it: how long
// wait_for_project keeps waiting through such a wait before it reports it.
const AUTONOMY_GRACE_MS = 30_000;

/** A state in which the project is not the user's to act on yet: queued for its turn, or the agents at work. */
export function isBusy(state: string | undefined): boolean {
  return state === 'queued' || state === 'working';
}

/**
 * Whether HumanPen may be about to answer what a project needs from its user (its autonomy covers it): a plan to
 * confirm (HumanPen confirms it when its own estimate fits what is left of the cap; the API does not show that
 * estimate, so the grace below decides), or questions it answers with the recommended answers.
 */
export function autonomyWillAnswer(project: Project): boolean {
  const autonomy = project.autonomy;
  if (!autonomy || project.state !== 'input_required') return false;
  const needed = project.required_input?.type;
  if (needed === 'confirm_or_revise_plan') return autonomy.confirm_plan === 'auto';
  return needed === 'answer_questions' && autonomy.answer === 'recommended';
}

// What the API accepts; checked here so the failure is a sentence rather than
// a heap exhaustion partway through the read.
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

export class HumanPenClient {
  private readonly baseUrl: string;

  constructor(private readonly apiKey: string, baseUrl?: string) {
    this.baseUrl = (baseUrl ?? process.env.HUMANPEN_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  }

  private async request<T>(method: string, path: string, body?: BodyInit,
    extraHeaders: Record<string, string> = {}): Promise<T> {
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
          ...extraHeaders,
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
      if (response.status === 403 && /projects:/.test(message)) {
        message += ` - research projects need a key created with "Research projects" ticked, at ${KEYS_URL}`;
      }
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

  /** A page of this account's jobs, newest first; `type` narrows it to one kind of job. */
  async listJobs(options: { limit?: number; offset?: number; type?: string } = {}): Promise<JobList> {
    const query = new URLSearchParams();
    if (options.limit !== undefined) query.set('limit', String(options.limit));
    if (options.offset !== undefined) query.set('offset', String(options.offset));
    if (options.type) query.set('type', options.type);
    return this.request<JobList>('GET', `/jobs?${query.toString()}`);
  }

  /** Cancel a queued or running job. The API returns the credits it reserved: a cancelled job is never charged. */
  async cancelJob(jobId: string): Promise<Job> {
    return this.request<Job>('POST', `/jobs/${jobId}/cancel`);
  }

  /** Run a failed or cancelled job again from its stored source, with the same settings; credits are reserved anew. */
  async retryJob(jobId: string): Promise<Job> {
    return this.request<Job>('POST', `/jobs/${jobId}/retry`);
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

  // ---------- research projects ----------

  /** A JSON request, with an Idempotency-Key where a retry must not do the thing twice. */
  private json<T>(method: string, path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    return this.request<T>(method, path, body === undefined ? undefined : JSON.stringify(body), headers);
  }

  /** Name and size of each local file, as a project announces its input; names must differ. */
  async describeFiles(paths: string[]): Promise<Array<{ name: string; size: number; path: string }>> {
    const files = [];
    for (const path of paths) {
      let size: number;
      try {
        size = (await stat(path)).size;
      } catch {
        throw new HumanPenError(`no such file: ${path}`, 'FILE_NOT_FOUND');
      }
      files.push({ name: basename(path), size, path });
    }
    const names = files.map((file) => file.name);
    const repeated = names.find((name, index) => names.indexOf(name) !== index);
    if (repeated) throw new HumanPenError(`two files are named ${repeated}; rename one`, 'DUPLICATE_FILE_NAME');
    return files;
  }

  async createProject(body: Record<string, unknown>): Promise<{ project: Project; uploads: ProjectUpload[] }> {
    return this.json('POST', '/agent/projects', body, randomUUID());
  }

  async addProjectUploads(projectId: string, files: Array<{ name: string; size: number }>): Promise<{ uploads: ProjectUpload[] }> {
    return this.json('POST', `/agent/projects/${projectId}/uploads`, { files }, randomUUID());
  }

  /**
   * Send each file's bytes to its signed target (no Authorization header: the URL is the credential), a large one
   * part by part from disk, then tell the project they are in.
   */
  async uploadProjectFiles(projectId: string, uploads: ProjectUpload[],
    files: Array<{ name: string; path: string }>): Promise<string[]> {
    const done = [];
    for (const upload of uploads) {
      const file = files.find((item) => item.name === upload.name);
      if (!file) throw new HumanPenError(`the API asked for a file not sent: ${upload.name}`, 'UPLOAD_MISMATCH');
      const target = upload.target;
      if (target.method === 'PUT') {
        await this.put(target.url, await readFile(file.path), target.headers);
        done.push({ name: upload.name });
      } else if (target.method === 'MULTIPART') {
        const parts = [];
        const handle = await open(file.path, 'r');
        try {
          for (const part of target.parts) {
            const buffer = Buffer.alloc(target.part_size);
            const { bytesRead } = await handle.read(buffer, 0, target.part_size, (part.number - 1) * target.part_size);
            const etag = await this.put(part.url, buffer.subarray(0, bytesRead));
            parts.push({ number: part.number, etag });
          }
        } finally {
          await handle.close();
        }
        done.push({ name: upload.name, upload_id: target.upload_id, parts });
      } else {
        throw new HumanPenError(`unknown upload target for ${upload.name}`, 'UPLOAD_MISMATCH');
      }
    }
    if (done.length) await this.json('POST', `/agent/projects/${projectId}/uploads/complete`, { files: done });
    return done.map((item) => item.name);
  }

  /** PUT bytes to a signed URL; the ETag it answers is what completes a multipart upload. */
  private async put(url: string, bytes: Buffer, headers: Record<string, string> = {}): Promise<string> {
    let response: Response;
    try {
      // A Blob of the bytes: a body every fetch accepts, with its length known up front (the signed URL fixes it).
      response = await fetch(url, { method: 'PUT', body: new Blob([new Uint8Array(bytes)]), headers });
    } catch (cause) {
      throw new HumanPenError(`uploading failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        'UPLOAD_FAILED', true);
    }
    if (!response.ok) throw new HumanPenError(`uploading failed with HTTP ${response.status}`, 'UPLOAD_FAILED', true);
    return response.headers.get('etag') ?? '';
  }

  async sendProjectMessage(projectId: string, text: string, attachments: string[] = []): Promise<{ seq: number | null }> {
    return this.json('POST', `/agent/projects/${projectId}/messages`,
      attachments.length ? { text, attachments } : { text }, randomUUID());
  }

  async getProject(projectId: string): Promise<Project> {
    return this.request<Project>('GET', `/agent/projects/${projectId}`);
  }

  async getProjectStatus(projectId: string): Promise<Project> {
    return this.request<Project>('GET', `/agent/projects/${projectId}/status`);
  }

  async actOnProject(projectId: string, body: Record<string, unknown>): Promise<{ seq: number | null }> {
    return this.json('POST', `/agent/projects/${projectId}/actions`, body, randomUUID());
  }

  async projectEvents(projectId: string, options: { after?: number; types?: string[]; wait?: number; limit?: number }):
    Promise<{ events: ProjectEvent[]; next_after: number }> {
    const query = new URLSearchParams({ after: String(options.after ?? 0), limit: String(options.limit ?? 200) });
    if (options.types?.length) query.set('types', options.types.join(','));
    if (options.wait) query.set('wait', String(Math.min(30, Math.max(0, Math.floor(options.wait)))));
    return this.request('GET', `/agent/projects/${projectId}/events?${query}`);
  }

  /** The latest few events of some types, reading the timeline from its start. */
  async latestProjectEvents(projectId: string, types: string[], keep: number): Promise<ProjectEvent[]> {
    let after = 0;
    let kept: ProjectEvent[] = [];
    for (let page = 0; page < 20; page += 1) {
      const answer = await this.projectEvents(projectId, { after, types, limit: 500 });
      kept = [...kept, ...answer.events].slice(-keep);
      if (!answer.events.length && answer.next_after === after) break;
      after = answer.next_after;
    }
    return kept;
  }

  /**
   * Wait until a project needs its user or has finished (its state leaves working), but not past `waitMs`. With
   * `after` (the seq a message or an action returned), what counts is a state the project reached after it, read
   * from the timeline by long polling; without it, the state now, polled gently.
   */
  async waitForProject(projectId: string, after: number | undefined, waitMs: number):
    Promise<{ project: Project; next_after?: number }> {
    const deadline = Date.now() + waitMs;
    // A wait HumanPen is about to answer for the user is waited through, a little past the deadline if need be.
    let grace: number | undefined;
    const settled = async (): Promise<Project | undefined> => {
      const project = await this.getProject(projectId);
      if (!autonomyWillAnswer(project)) return project;
      grace ??= Date.now() + AUTONOMY_GRACE_MS;
      return Date.now() >= grace ? project : undefined;
    };
    if (after === undefined) {
      let delay = POLL_FIRST_MS;
      for (;;) {
        const status = await this.getProjectStatus(projectId);
        if (!isBusy(status.state)) {
          const project = await settled();
          if (project) return { project };
          delay = POLL_FIRST_MS;
        } else if (Date.now() >= deadline) {
          return { project: await this.getProject(projectId) };
        }
        await new Promise((resolve) => setTimeout(resolve, Math.min(delay, Math.max(1_000, deadline - Date.now()))));
        delay = Math.min(delay * 2, POLL_MAX_MS);
      }
    }
    let cursor = after;
    while (Date.now() < deadline || (grace !== undefined && Date.now() < grace)) {
      const left = Math.floor((Math.max(deadline, grace ?? 0) - Date.now()) / 1000);
      const page = await this.projectEvents(projectId, { after: cursor, types: ['project.state'], wait: Math.max(1, left) });
      cursor = page.next_after;
      const last = page.events.at(-1);
      if (last && typeof last.data.state === 'string' && !isBusy(last.data.state)) {
        const project = await settled();
        if (project) return { project, next_after: cursor };
      }
    }
    return { project: await this.getProject(projectId), next_after: cursor };
  }

  async listProjectDeliveries(projectId: string): Promise<{ deliveries: ProjectDelivery[] }> {
    return this.request('GET', `/agent/projects/${projectId}/deliveries`);
  }

  /**
   * Save a delivered version's zip in a directory. The API answers with a redirect to a short-lived signed URL,
   * followed here without the Authorization header (the URL is the credential, and the key must not leave).
   */
  async downloadProjectDelivery(projectId: string, version: number, target: string): Promise<{ path: string; bytes: number }> {
    const path = `/agent/projects/${projectId}/deliveries/${version}/zip`;
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        redirect: 'manual',
        headers: { Authorization: `Bearer ${this.apiKey}`, 'User-Agent': 'humanpen-mcp/1.0' },
      });
    } catch (cause) {
      throw new HumanPenError(`cannot reach ${this.baseUrl}: ${cause instanceof Error ? cause.message : String(cause)}`,
        'NETWORK', true);
    }
    const location = response.headers.get('location');
    if (!(response.status >= 300 && response.status < 400 && location)) {
      const payload = (await response.json().catch(() => ({}))) as { code?: string; message?: string };
      throw new HumanPenError(`HTTP ${response.status} ${payload.code ?? ''}: ${payload.message ?? 'no delivery zip'}`,
        payload.code ?? '', response.status >= 500);
    }
    const file = await fetch(location);
    if (!file.ok) throw new HumanPenError(`downloading the delivery failed with HTTP ${file.status}`, 'DOWNLOAD_FAILED', true);
    const bytes = Buffer.from(await file.arrayBuffer());
    await writeFile(target, bytes);
    return { path: target, bytes: bytes.length };
  }
}
