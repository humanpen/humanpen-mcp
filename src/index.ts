#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { HumanPenClient, HumanPenError, type Job, type JobReceipt } from './client.js';

export { HumanPenClient, HumanPenError } from './client.js';

// Replaced at build time from package.json (see tsup.config.ts).
declare const __PACKAGE_VERSION__: string;
const VERSION = __PACKAGE_VERSION__;

// Long enough that most jobs finish inside one tool call, short enough to
// stay under the timeout MCP clients apply. What is left over is handled by
// handing the caller a job id instead of a dead request.
const DEFAULT_WAIT_SECONDS = 55;
const MAX_WAIT_SECONDS = 240;

const apiKey = process.env.HUMANPEN_API_KEY?.trim();
if (!apiKey) {
  // stderr, not stdout: stdout is the JSON-RPC channel and anything else
  // written there corrupts the protocol.
  console.error(
    'HUMANPEN_API_KEY is not set.\n' +
      'Create a key at https://humanpen.net/settings/api-keys (new accounts get 100 free credits),\n' +
      'then set it in your MCP client config, e.g. "env": { "HUMANPEN_API_KEY": "hp_..." }.',
  );
  process.exit(1);
}

const client = new HumanPenClient(apiKey);
const server = new McpServer({ name: 'humanpen', version: VERSION });

/** Render a value as the single text block MCP tools answer with. */
function text(payload: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2),
      },
    ],
  };
}

/**
 * Answer with an error the model can act on.
 *
 * `isError` marks it as a failure rather than a result - without it a model
 * reads the message as data and carries on as though the work happened.
 */
function failure(cause: unknown) {
  const error =
    cause instanceof HumanPenError
      ? cause
      : new HumanPenError(cause instanceof Error ? cause.message : String(cause));
  return {
    isError: true,
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            error: error.message,
            code: error.code || undefined,
            retryable: error.retryable,
          },
          null,
          2,
        ),
      },
    ],
  };
}

/** What the model needs about a job, and nothing it does not. */
function describeJob(job: Job, outputPath?: string) {
  return {
    job_id: job.job_id,
    operation: job.operation,
    status: job.status,
    finished: job.finished,
    progress_percent: job.progress_percent,
    credits_charged: job.credits?.charged ?? null,
    source_words: job.source?.words ?? null,
    result_words: job.result?.words ?? null,
    output_path: outputPath ?? null,
    error: job.error ?? null,
  };
}

/**
 * Run one operation end to end: submit, wait, save the result, report.
 *
 * The whole job lives inside one tool call because the alternative - handing
 * back a job id and trusting the model to remember to poll - is a loop that
 * gets abandoned halfway. Only when the wait budget runs out does the caller
 * get an id, and then with an explicit instruction to use check_job.
 */
async function awaitAndDownload(
  receipt: JobReceipt,
  downloadAnchor: string,
  options: { outputPath?: string; waitSeconds?: number },
) {
  const waitMs =
    Math.min(Math.max(options.waitSeconds ?? DEFAULT_WAIT_SECONDS, 0), MAX_WAIT_SECONDS) * 1000;
  const job = await client.waitForJob(receipt.job_id, waitMs);
  if (!job.finished) {
    return text({
      ...describeJob(job),
      credits_frozen: receipt.credits_frozen,
      note:
        'Still running - this is normal, jobs take minutes. Call check_job with this job_id ' +
        'to pick it up; the work continues either way.',
    });
  }
  if (job.status !== 'DONE') {
    return failure(
      new HumanPenError(
        `job ${job.status}: ${job.error?.message ?? 'no detail given'}`,
        job.error?.code ?? '',
      ),
    );
  }
  // The result is named by the API; it lands next to the anchor file the caller
  // has on disk (the source document, or - for a free re-humanize, which uploads
  // no source - the report) unless an explicit output path is given.
  const outputPath = await client.downloadResult(job, downloadAnchor, options.outputPath);
  return text(describeJob(job, outputPath));
}

async function runOperation(
  operation: string,
  documentPath: string,
  fields: Record<string, string | undefined>,
  options: { outputPath?: string; waitSeconds?: number; reportPath?: string },
) {
  try {
    const receipt = await client.createJob(operation, documentPath, fields, options.reportPath);
    return await awaitAndDownload(receipt, documentPath, options);
  } catch (cause) {
    return failure(cause);
  }
}

/**
 * Continue a finished humanize job for free: no source document is uploaded (the
 * server clones the parent's result), just the fresh report and optional fields,
 * POSTed to the parent's free-rehumanize endpoint. Every eligibility gate - one
 * chance per job, the daily cap, the report matching that job's output - lives on
 * the server; this only forwards the request and surfaces whatever it decides.
 */
async function runFreeRehumanize(
  parentJobId: string,
  reportPath: string,
  fields: Record<string, string | undefined>,
  options: { outputPath?: string; waitSeconds?: number },
) {
  try {
    const receipt = await client.createFreeRehumanizeJob(parentJobId, reportPath, fields);
    return await awaitAndDownload(receipt, reportPath, options);
  } catch (cause) {
    return failure(cause);
  }
}

/** The shared per-passage word-control schema (humanize and free re-humanize). */
const WORD_SEGMENTS = z
  .array(
    z.object({
      text: z.string().min(1).describe('The exact flagged passage text to bound'),
      min_words: z.number().int().positive().optional().describe('Lower word bound for this passage once rewritten'),
      max_words: z.number().int().positive().optional().describe('Upper word bound for this passage once rewritten'),
    }),
  )
  .min(1);

/** Encode the tool's segments onto the API's segments JSON field, or undefined. */
function encodeSegments(
  segments: Array<{ text: string; min_words?: number; max_words?: number }> | undefined,
): string | undefined {
  // The API reads segments as a JSON array of {text, word_min?, word_max?}; map
  // the tool's names onto those. JSON.stringify drops undefined bounds, so an
  // unset bound is simply absent.
  return segments !== undefined
    ? JSON.stringify(segments.map((s) => ({ text: s.text, word_min: s.min_words, word_max: s.max_words })))
    : undefined;
}

// Each operation is its own tool rather than one tool with an `operation`
// argument: the name is what a model selects on, and the four take genuinely
// different parameters. It mirrors the API, which has one endpoint each for
// the same reason.

server.registerTool(
  'humanize_document',
  {
    title: 'Humanize a document',
    description:
      'Rewrite a .docx or .pptx so it reads as human-written and scores lower on AI detectors, ' +
      'keeping meaning, citations, tables and layout. Optionally pass a Turnitin/iThenticate AI ' +
      'report to rewrite only the passages it flagged. If a fresh report still flags the result, ' +
      'run this tool again on the rewritten file with that new report - only the still-flagged ' +
      'passages are touched, and balanced remains the right strategy for the second pass. ' +
      'Saves the result next to the source and ' +
      'returns its path. COSTS CREDITS at 100 per 1,000 words processed (10 minimum) - say so and get agreement first.',
    inputSchema: {
      document_path: z.string().describe('Absolute path to the .docx or .pptx to rewrite'),
      strategy: z
        .enum(['balanced', 'aggressive'])
        .optional()
        .describe('Rewriting intensity; balanced is the usual first choice, aggressive rewrites more heavily'),
      report_path: z
        .string()
        .optional()
        .describe('Path to a Turnitin/iThenticate AI report PDF; only its flagged passages are rewritten'),
      instructions: z.string().optional().describe('Extra requirements for this job'),
      output_path: z.string().optional().describe('Where to write the result; defaults to beside the source'),
      wait_seconds: z.number().optional().describe(`How long to wait before returning a job id (default ${DEFAULT_WAIT_SECONDS})`),
      min_words: z.number().int().positive().optional()
        .describe('Lower word bound for the rewritten document (optional; omit for no limit). Experimental - ' +
          'a word limit noticeably weakens AI-rate reduction, so omit unless the user requires a length. ' +
          'Cannot combine with report_path or segments.'),
      max_words: z.number().int().positive().optional()
        .describe('Upper word bound for the rewritten document (optional; omit for no limit). Same ' +
          'experimental caveat and exclusivity as min_words.'),
      segments: WORD_SEGMENTS.optional()
        .describe('Per-passage word control (optional): each item is a flagged passage plus its own ' +
          'min_words/max_words. Get the passage texts from read_detection_report and pass report_path ' +
          'alongside so the report defines scope. Experimental, same caveat as min_words. Cannot combine ' +
          'with the whole-document min_words/max_words.'),
    },
  },
  async ({ document_path, strategy, report_path, instructions, output_path, wait_seconds, min_words, max_words, segments }) => {
    // The whole-document band and the per-passage paths scope the job to different
    // things - the band to the whole document, a report or segments to specific
    // passages - and the API forbids the mix. It derives a report's passages later,
    // so it would take the job (and its charge) before mismatching; refuse here.
    // Per-passage limits ride on segments, which DO combine with a report (the
    // report's flagged passages are exactly their scope).
    const wholeBand = min_words !== undefined || max_words !== undefined;
    if (wholeBand && report_path !== undefined) {
      return failure(new HumanPenError(
        "min_words/max_words target the whole document and can't combine with report_path, which " +
          'rewrites only the flagged passages. For per-passage limits use segments instead.',
        'INVALID_WORD_BUDGET'));
    }
    if (wholeBand && segments !== undefined) {
      return failure(new HumanPenError(
        "min_words/max_words target the whole document and can't combine with segments, which carry " +
          'their own per-passage limits. Use one or the other.',
        'INVALID_WORD_BUDGET'));
    }
    return runOperation(
      'humanize',
      document_path,
      {
        strategy,
        additional_instructions: instructions,
        word_min: min_words !== undefined ? String(min_words) : undefined,
        word_max: max_words !== undefined ? String(max_words) : undefined,
        segments: encodeSegments(segments),
      },
      { outputPath: output_path, waitSeconds: wait_seconds, reportPath: report_path },
    );
  },
);

server.registerTool(
  'free_rehumanize',
  {
    title: "Re-humanize a job's still-flagged passages for free",
    description:
      "Continue a finished humanize job for FREE. Upload a fresh detection report for that job's result; only " +
      'the passages it still flags are rewritten, at no credit cost. The server enforces strict limits: one free ' +
      "continuation per job, a per-day cap, the report must be of THAT job's own result (>=90% match) and show " +
      '>=20% AI, and the result must still exist (kept ~7 days). If a limit is not met it returns a clear reason - ' +
      'relay it and stop; do not retry or silently fall back to a paid job. Pass the job_id a prior ' +
      'humanize_document (or check_job) returned.',
    inputSchema: {
      job_id: z.string().describe('The finished humanize job to continue (its job_id from humanize_document/check_job)'),
      report_path: z.string().describe("Absolute path to the fresh Turnitin/iThenticate report for that job's result"),
      segments: WORD_SEGMENTS.optional()
        .describe('Per-passage word control for the still-flagged passages (optional), same shape and ' +
          'experimental caveat as humanize_document.segments'),
      instructions: z.string().optional().describe('Extra requirements for this job'),
      output_path: z.string().optional().describe('Where to write the result; defaults to beside the report'),
      wait_seconds: z.number().optional().describe(`How long to wait before returning a job id (default ${DEFAULT_WAIT_SECONDS})`),
    },
  },
  async ({ job_id, report_path, segments, instructions, output_path, wait_seconds }) =>
    runFreeRehumanize(
      job_id,
      report_path,
      { additional_instructions: instructions, segments: encodeSegments(segments) },
      { outputPath: output_path, waitSeconds: wait_seconds },
    ),
);

server.registerTool(
  'fix_citations',
  {
    title: 'Convert citation format',
    description:
      'Rewrite a .docx\'s in-text citations and reference list into one target style, leaving the ' +
      'body text alone. Saves the result next to the source and returns its path. COSTS CREDITS at ' +
      '100 per 1,000 words processed (10 minimum) - say so and get agreement first.',
    inputSchema: {
      document_path: z.string().describe('Absolute path to the .docx'),
      style: z
        .string()
        .describe('Target style: apa7, mla9, harvard, chicago_author_date, chicago_notes, ieee, vancouver, gbt7714, gbt7714_author_year, ama, acs, or oscola'),
      instructions: z.string().optional().describe('Extra requirements for this job'),
      output_path: z.string().optional().describe('Where to write the result; defaults to beside the source'),
      wait_seconds: z.number().optional().describe(`How long to wait before returning a job id (default ${DEFAULT_WAIT_SECONDS})`),
    },
  },
  async ({ document_path, style, instructions, output_path, wait_seconds }) =>
    runOperation(
      'citation-format-correction',
      document_path,
      { citation_style: style, additional_instructions: instructions },
      { outputPath: output_path, waitSeconds: wait_seconds },
    ),
);

server.registerTool(
  'condense_document',
  {
    title: 'Condense a document',
    description:
      'Shorten a .docx to a target word count, keeping meaning, structure and citations. Saves the ' +
      'result next to the source and returns its path. COSTS CREDITS at 100 per 1,000 words processed (10 minimum) - say so and get agreement first.',
    inputSchema: {
      document_path: z.string().describe('Absolute path to the .docx'),
      max_words: z.number().int().positive().describe('Target word count for the whole document'),
      instructions: z.string().optional().describe('Extra requirements for this job'),
      output_path: z.string().optional().describe('Where to write the result; defaults to beside the source'),
      wait_seconds: z.number().optional().describe(`How long to wait before returning a job id (default ${DEFAULT_WAIT_SECONDS})`),
    },
  },
  async ({ document_path, max_words, instructions, output_path, wait_seconds }) =>
    runOperation(
      'condense',
      document_path,
      { max_words: String(max_words), additional_instructions: instructions },
      { outputPath: output_path, waitSeconds: wait_seconds },
    ),
);

server.registerTool(
  'translate_document',
  {
    title: 'Translate a document',
    description:
      'Translate a document into another language while keeping its layout, tables, images and ' +
      'formulas. Takes .docx, .pdf, .pptx, .xlsx, .epub, .html and .txt. Saves the result next to ' +
      'the source and returns its path. COSTS CREDITS at 100 per 1,000 words processed (10 minimum) - say so and get agreement first.',
    inputSchema: {
      document_path: z.string().describe('Absolute path to the document'),
      target_lang: z.string().describe('Target language: zh, en, zh-tw, ja, ko, es, fr, pt, ru, de, pl or it'),
      source_lang: z.string().optional().describe('Source language, or auto to detect it (the default)'),
      output_path: z.string().optional().describe('Where to write the result; defaults to beside the source'),
      wait_seconds: z.number().optional().describe(`How long to wait before returning a job id (default ${DEFAULT_WAIT_SECONDS})`),
    },
  },
  async ({ document_path, target_lang, source_lang, output_path, wait_seconds }) =>
    runOperation(
      'translate',
      document_path,
      { target_lang, source_lang },
      { outputPath: output_path, waitSeconds: wait_seconds },
    ),
);

server.registerTool(
  'read_detection_report',
  {
    title: 'Read an AI-detection report',
    description:
      'Read a Turnitin or iThenticate AI Writing report PDF: returns the overall AI percentage and ' +
      'the flagged passages. Free - reads the file without starting a job. Pass the same report to ' +
      'humanize_document to rewrite only what was flagged.',
    inputSchema: {
      report_path: z.string().describe('Absolute path to the report PDF'),
      type: z
        .enum(['turnitin', 'ithenticate'])
        .optional()
        .describe('Which product exported it; omit to identify it from the file'),
      include_segments: z
        .boolean()
        .optional()
        .describe('Include the flagged passage texts, which can be long (default false)'),
    },
  },
  async ({ report_path, type, include_segments }) => {
    try {
      const report = await client.parseReport(report_path, type);
      return text({
        report_type: report.report_type,
        // Null means the report printed "*" rather than a number. Turnitin
        // does that whenever AI writing is under 20%, a band it refuses to
        // quantify because of false positives - so null is usually good news,
        // not a missing result. It is never zero, and reporting "0% AI" from
        // it would be a claim nobody made.
        ai_percent: report.ai_percent,
        page_count: report.page_count,
        segment_count: report.segment_count,
        problem_type_counts: report.problem_type_counts,
        segments: include_segments ? report.segments : undefined,
      });
    } catch (cause) {
      return failure(cause);
    }
  },
);

server.registerTool(
  'check_job',
  {
    title: 'Check a job',
    description:
      'Look up a job by id, and download its result if it has finished. Use this after a tool ' +
      'returned before the job was done.',
    inputSchema: {
      job_id: z.string().describe('The job id an earlier call returned'),
      document_path: z
        .string()
        .optional()
        .describe('The original document, so a downloaded result can be named after it'),
      output_path: z.string().optional().describe('Where to write the result'),
    },
  },
  async ({ job_id, document_path, output_path }) => {
    try {
      const job = await client.getJob(job_id);
      let outputPath: string | undefined;
      // Only download when told where to put it. Falling back to a bare name
      // would drop the file in whatever directory the agent happens to be
      // running from, which is nobody's intent.
      if (job.status === 'DONE' && (document_path || output_path)) {
        outputPath = await client.downloadResult(job, document_path ?? output_path!, output_path);
      }
      return text(describeJob(job, outputPath));
    } catch (cause) {
      return failure(cause);
    }
  },
);

server.registerTool(
  'get_credit_balance',
  {
    title: 'Check the credit balance',
    description:
      'How many credits the account has. 1,000 words costs 100 credits, charged on the words ' +
      'actually processed, with a 10-credit minimum per job. Worth checking before a large document.',
    inputSchema: {},
  },
  async () => {
    try {
      return text(await client.getBalance());
    } catch (cause) {
      return failure(cause);
    }
  },
);

async function main() {
  await server.connect(new StdioServerTransport());
}

main().catch((cause) => {
  console.error(`humanpen-mcp failed to start: ${cause instanceof Error ? cause.message : cause}`);
  process.exit(1);
});
