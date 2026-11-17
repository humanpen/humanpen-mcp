#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { HumanPenClient, HumanPenError, isBusy, type Job, type JobReceipt, type Project } from './client.js';

export { HumanPenClient, HumanPenError } from './client.js';

// Replaced at build time from package.json (see tsup.config.ts).
declare const __PACKAGE_VERSION__: string;
const VERSION = __PACKAGE_VERSION__;

// Long enough that most jobs finish inside one tool call, short enough to
// stay under the timeout MCP clients apply. What is left over is handled by
// handing the caller a job id instead of a dead request.
const DEFAULT_WAIT_SECONDS = 55;
const MAX_WAIT_SECONDS = 240;

const MISSING_KEY_HELP =
  'HUMANPEN_API_KEY is not set.\n' +
  'Create a key at https://humanpen.net/settings/api-keys (new accounts get 100 free credits),\n' +
  'then set it in your MCP client config, e.g. "env": { "HUMANPEN_API_KEY": "hp_..." }.';

// The key is a credential for the remote API, not a precondition of this
// process: a keyless server still answers initialize and tools/list (that is
// how clients and directory scanners inspect it), so the missing-key error
// surfaces on the first call that would actually use the credential - where
// it can be acted on - instead of killing the server at startup.
let client: HumanPenClient | undefined;
function api(): HumanPenClient {
  if (!client) {
    const apiKey = process.env.HUMANPEN_API_KEY?.trim();
    if (!apiKey) throw new HumanPenError(MISSING_KEY_HELP, 'MISSING_API_KEY');
    client = new HumanPenClient(apiKey);
  }
  return client;
}

if (!process.env.HUMANPEN_API_KEY?.trim()) {
  // stderr, not stdout: stdout is the JSON-RPC channel and anything else
  // written there corrupts the protocol.
  console.error('humanpen-mcp: HUMANPEN_API_KEY is not set; tool calls will fail with setup instructions until it is.');
}

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
  const job = await api().waitForJob(receipt.job_id, waitMs);
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
  const outputPath = await api().downloadResult(job, downloadAnchor, options.outputPath);
  return text(describeJob(job, outputPath));
}

async function runOperation(
  operation: string,
  documentPath: string,
  fields: Record<string, string | undefined>,
  options: { outputPath?: string; waitSeconds?: number; reportPath?: string },
) {
  try {
    const receipt = await api().createJob(operation, documentPath, fields, options.reportPath);
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
    const receipt = await api().createFreeRehumanizeJob(parentJobId, reportPath, fields);
    return await awaitAndDownload(receipt, reportPath, options);
  } catch (cause) {
    return failure(cause);
  }
}

/** The shared per-passage word-control schema (humanize and free re-humanize). */
const WORD_SEGMENTS = z
  .array(
    z.object({
      text: z.string().min(1).describe('A passage, copied exactly from the document'),
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
//
// Annotations, for clients that gate on them: no tool destroys data - every
// writer only adds a new file beside an existing one - and only the lookups are
// read-only. destructiveHint defaults to true when a tool is not read-only, so
// the explicit false is the half that carries information; cancel_job keeps
// true, since it stops work that cannot be resumed (retry_job starts it over).

server.registerTool(
  'humanize_document',
  {
    title: 'Humanize a document',
    annotations: { readOnlyHint: false, destructiveHint: false },
    description:
      'Rewrite a .docx or .pptx so it reads as human-written and scores lower on AI detectors, ' +
      'keeping meaning, citations, tables and layout. Optionally pass a Turnitin/iThenticate AI ' +
      'report, or passages of your own (segments), to rewrite only those. If a fresh report still flags the result, ' +
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
        .describe('Rewrite only these passages (optional), each copied exactly from the document, with its own ' +
          'min_words/max_words if wanted. Alone they set the scope; with report_path, take them from ' +
          'read_detection_report. A paragraph is the smallest unit: each passage is widened to its whole ' +
          'paragraph, and billed as such. Word bounds are experimental, same caveat as min_words. Cannot ' +
          'combine with the whole-document min_words/max_words.'),
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
    annotations: { readOnlyHint: false, destructiveHint: false },
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
      strategy: z.enum(['balanced', 'aggressive']).optional()
        .describe('Rewriting intensity (default balanced, the recommended choice for a continuation)'),
      segments: WORD_SEGMENTS.optional()
        .describe('Per-passage word control for the still-flagged passages (optional), same shape and ' +
          'experimental caveat as humanize_document.segments'),
      instructions: z.string().optional().describe('Extra requirements for this job'),
      output_path: z.string().optional().describe('Where to write the result; defaults to beside the report'),
      wait_seconds: z.number().optional().describe(`How long to wait before returning a job id (default ${DEFAULT_WAIT_SECONDS})`),
    },
  },
  async ({ job_id, report_path, strategy, segments, instructions, output_path, wait_seconds }) =>
    runFreeRehumanize(
      job_id,
      report_path,
      { strategy, additional_instructions: instructions, segments: encodeSegments(segments) },
      { outputPath: output_path, waitSeconds: wait_seconds },
    ),
);

server.registerTool(
  'fix_citations',
  {
    title: 'Convert citation format',
    annotations: { readOnlyHint: false, destructiveHint: false },
    description:
      'Rewrite a .docx\'s in-text citations and reference list into one target style, leaving the ' +
      'body text alone. Saves the result next to the source and returns its path. COSTS CREDITS at ' +
      '5 per 1,000 words processed (10 minimum) - say so and get agreement first.',
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
    annotations: { readOnlyHint: false, destructiveHint: false },
    description:
      'Shorten a .docx, keeping meaning, structure and citations: the whole document to max_words, or only ' +
      'chosen passages (segments), each to its own budget. Saves the result next to the source and returns its ' +
      'path. COSTS CREDITS at 20 per 1,000 words processed (10 minimum) - say so and get agreement first.',
    inputSchema: {
      document_path: z.string().describe('Absolute path to the .docx'),
      max_words: z.number().int().positive().optional()
        .describe('Target word count for the whole document (or use segments)'),
      segments: z
        .array(
          z.object({
            text: z.string().min(1).describe('A passage to shorten, copied exactly from the document'),
            max_words: z.number().int().positive().describe('Word budget for this passage'),
          }),
        )
        .min(1)
        .optional()
        .describe('Shorten only these passages, each to its own budget, instead of max_words. A paragraph is ' +
          'the smallest unit: each passage is widened to its whole paragraph.'),
      mode: z
        .enum(['rewrite', 'delete'])
        .optional()
        .describe('rewrite (default) condenses sentences in place; delete removes whole low-value sentences ' +
          'and keeps every other word verbatim'),
      instructions: z.string().optional().describe('Extra requirements for this job'),
      output_path: z.string().optional().describe('Where to write the result; defaults to beside the source'),
      wait_seconds: z.number().optional().describe(`How long to wait before returning a job id (default ${DEFAULT_WAIT_SECONDS})`),
    },
  },
  async ({ document_path, max_words, segments, mode, instructions, output_path, wait_seconds }) => {
    // The API takes one target or the other; refuse a mix (or neither) here, before the upload.
    if ((max_words === undefined) === (segments === undefined)) {
      return failure(new HumanPenError(
        'Give either max_words (the whole document) or segments (chosen passages, each with its own budget), ' +
          'not both and not neither.',
        'INVALID_WORD_BUDGET'));
    }
    return runOperation(
      'condense',
      document_path,
      {
        max_words: max_words !== undefined ? String(max_words) : undefined,
        segments: segments !== undefined ? JSON.stringify(segments.map((s) => ({ text: s.text, max_words: s.max_words })))
          : undefined,
        mode,
        additional_instructions: instructions,
      },
      { outputPath: output_path, waitSeconds: wait_seconds },
    );
  },
);

server.registerTool(
  'translate_document',
  {
    title: 'Translate a document',
    annotations: { readOnlyHint: false, destructiveHint: false },
    description:
      'Translate a document into another language while keeping its layout, tables, images and ' +
      'formulas. Takes .docx, .pdf, .pptx, .xlsx, .epub, .html and .txt. Saves the result next to ' +
      'the source and returns its path. COSTS CREDITS at 10 per 1,000 words processed (10 minimum) - say so and get agreement first.',
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
    annotations: { readOnlyHint: true },
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
      const report = await api().parseReport(report_path, type);
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
    annotations: { readOnlyHint: false, destructiveHint: false },
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
      const job = await api().getJob(job_id);
      let outputPath: string | undefined;
      // Only download when told where to put it. Falling back to a bare name
      // would drop the file in whatever directory the agent happens to be
      // running from, which is nobody's intent.
      if (job.status === 'DONE' && (document_path || output_path)) {
        outputPath = await api().downloadResult(job, document_path ?? output_path!, output_path);
      }
      return text(describeJob(job, outputPath));
    } catch (cause) {
      return failure(cause);
    }
  },
);

/** One line of a job list: what tells jobs apart, and what a next step needs. */
function summarizeJob(job: Job) {
  return {
    job_id: job.job_id,
    operation: job.operation,
    status: job.status,
    progress_percent: job.progress_percent,
    file: job.source?.filename ?? null,
    credits_charged: job.credits?.charged ?? null,
    created_at: job.created_at,
    error: job.error?.code ?? null,
  };
}

server.registerTool(
  'list_jobs',
  {
    title: 'List jobs',
    annotations: { readOnlyHint: true },
    description:
      "List this account's document jobs, newest first, with their status and credits - to find a job id for " +
      'check_job, cancel_job or retry_job. Free.',
    inputSchema: {
      type: z
        .enum(['humanize', 'condense', 'citation_format_correction', 'translate'])
        .optional()
        .describe('Only jobs of this kind'),
      limit: z.number().int().min(1).max(100).optional().describe('How many to return (default 20)'),
      offset: z.number().int().min(0).optional().describe('How many to skip, for the next page'),
    },
  },
  async ({ type, limit, offset }) => {
    try {
      const page = await api().listJobs({ type, limit: limit ?? 20, offset });
      return text({ total: page.total, has_more: page.has_more, jobs: page.items.map(summarizeJob) });
    } catch (cause) {
      return failure(cause);
    }
  },
);

server.registerTool(
  'cancel_job',
  {
    title: 'Cancel a job',
    annotations: { readOnlyHint: false, destructiveHint: true },
    description:
      'Cancel a document job that is still queued or running. Its reserved credits are returned - a cancelled ' +
      'job is never charged - and retry_job can run it again later. Free.',
    inputSchema: {
      job_id: z.string().describe('The job to cancel'),
    },
  },
  async ({ job_id }) => {
    try {
      return text(describeJob(await api().cancelJob(job_id)));
    } catch (cause) {
      return failure(cause);
    }
  },
);

server.registerTool(
  'retry_job',
  {
    title: 'Retry a job',
    annotations: { readOnlyHint: false, destructiveHint: false },
    description:
      'Run a failed or cancelled document job again with the same settings, from its stored source (kept about ' +
      '7 days). Pass document_path to wait and save the result there, as the other tools do. COSTS CREDITS like ' +
      'the original job - say so and get agreement first.',
    inputSchema: {
      job_id: z.string().describe('The failed or cancelled job to run again'),
      document_path: z
        .string()
        .optional()
        .describe('The original document, so the result is saved beside it and named after it'),
      output_path: z.string().optional().describe('Where to write the result'),
      wait_seconds: z.number().optional().describe(`How long to wait before returning (default ${DEFAULT_WAIT_SECONDS})`),
    },
  },
  async ({ job_id, document_path, output_path, wait_seconds }) => {
    try {
      const job = await api().retryJob(job_id);
      const anchor = document_path ?? output_path;
      if (!anchor) {
        return text({
          ...describeJob(job),
          note: 'Running again. Call check_job with this job_id, and the document path, to follow it and save the result.',
        });
      }
      const receipt: JobReceipt = {
        job_id: job.job_id, operation: job.operation, status: job.status,
        credits_frozen: job.credits?.frozen ?? 0, created_at: job.created_at,
      };
      return await awaitAndDownload(receipt, anchor, { outputPath: output_path, waitSeconds: wait_seconds });
    } catch (cause) {
      return failure(cause);
    }
  },
);

server.registerTool(
  'get_credit_balance',
  {
    title: 'Check the credit balance',
    annotations: { readOnlyHint: true },
    description:
      'How many credits the account has. Per 1,000 words processed: humanize 100 credits, citation ' +
      'fixes 5, condensing 20, translation 10, with a 10-credit minimum per job. Worth checking ' +
      'before a large document.',
    inputSchema: {},
  },
  async () => {
    try {
      return text(await api().getBalance());
    } catch (cause) {
      return failure(cause);
    }
  },
);

// ---------- research projects ----------
//
// A research project is a conversation with cloud agents rather than one job: they scope the request with the user,
// propose a plan, work, are reviewed and deliver, and in between they wait on the user. So these tools follow the
// API's own steps (start, look, act, wait, download) instead of hiding them in one call: what the agents ask and the
// plan they propose are the user's to answer, through the model.

/** The last thing the agents said, cut to what a model can relay. */
const MESSAGE_CHARS = 1500;

/** What the model needs about a project to tell the user and take the next step, and nothing more. */
async function describeProject(project: Project) {
  const needed = project.required_input ?? null;
  const plan = needed?.type === 'confirm_or_revise_plan' && project.spec
    ? {
      spec_version: project.spec_version,
      goal: project.spec.goal ?? project.spec.title ?? null,
      deliverables: Array.isArray(project.spec.deliverables)
        ? (project.spec.deliverables as Array<Record<string, unknown>>).map((item) => item.path ?? item.description)
        : undefined,
      estimate_minutes: project.estimate_minutes ?? null,
    }
    : undefined;
  // The scoping questions live in the timeline, not in the project; read them only while they wait for answers.
  let questions: unknown;
  if (needed?.type === 'answer_questions' && project.stage === 'scoping') {
    const [asked] = await api().latestProjectEvents(project.id, ['intake.questions'], 1);
    questions = asked?.data.questions;
  }
  let lastMessage: string | undefined;
  if (!isBusy(project.state)) {
    const [said] = await api().latestProjectEvents(project.id, ['agent.message'], 1);
    const words = typeof said?.data.text === 'string' ? said.data.text : undefined;
    lastMessage = words && words.length > MESSAGE_CHARS ? `${words.slice(0, MESSAGE_CHARS)}...` : words;
  }
  const billing = project.billing ?? {};
  return {
    project_id: project.id,
    title: project.title,
    state: project.state,
    stage: project.stage,
    needs_from_user: needed?.type ?? null,
    pause_id: needed?.pause_id,
    queue_position: project.queue_position ?? undefined,
    allowed_actions: project.allowed_actions,
    // Messages the agents have not read yet: they read them after the step they are on (deliver_now: at once).
    waiting_messages: project.pending_messages?.length ? project.pending_messages : undefined,
    now: project.activity?.description ?? null,
    progress: project.progress?.map((item) => `${item.status ?? 'todo'}: ${item.text ?? ''}`),
    question: project.question ?? undefined,
    questions,
    plan,
    last_message: lastMessage,
    delivered_version: project.delivered_version ?? null,
    consumed_credits: project.consumed_credits ?? billing.consumed_credits ?? null,
    credit_cap: project.autonomy?.max_credits ?? null,
    committed_credits: billing.committed_credits ?? null,
  };
}

/** The step after a tool that started the agents working, said once so the model does not have to infer it. */
const WAIT_NOTE = 'The agents work on it now. Call wait_for_project with this after_seq to hear when it needs the user ' +
  'or is done; it can take minutes to hours.';

const AUTONOMY = z
  .object({
    confirm_plan: z.enum(['ask', 'auto']).optional()
      .describe("auto: confirm a plan when HumanPen's estimate of it fits what is left of max_credits"),
    answer: z.enum(['ask', 'recommended']).optional()
      .describe("recommended: answer the agents' questions with their recommended answers"),
    max_credits: z.number().int().positive()
      .describe('The most the whole project may be charged, every round together; a figure the user agreed to'),
  })
  .describe('Let it run unattended within a credit cap the user set; omit to stop for the user at every step');

server.registerTool(
  'start_project',
  {
    title: 'Start a research project',
    annotations: { readOnlyHint: false, destructiveHint: false },
    description:
      "Hand a research, data analysis or writing task to HumanPen's cloud agents, with local files as its input: " +
      'they scope it with the user, propose a plan, do the work, have it reviewed and deliver files. ' +
      'COSTS CREDITS once a plan is confirmed (charged by use; there is no price up front): show the user the plan ' +
      'and get their agreement before act_on_project confirm_plan, unless they set autonomy with a max_credits. Needs an ' +
      'API key with "Research projects" ticked.',
    inputSchema: {
      request: z.string().min(1).describe('What the user wants done, in their words: the goal, the deliverables, any constraints'),
      files: z.array(z.string()).optional().describe('Absolute paths of input files (data, drafts, papers)'),
      title: z.string().max(256).optional().describe('A name for the project; one is made from the request if omitted'),
      lang: z.string().max(16).optional().describe('The language to write in, e.g. en or zh'),
      autonomy: AUTONOMY.optional(),
    },
  },
  async ({ request, files, title, lang, autonomy }) => {
    try {
      const local = await api().describeFiles(files ?? []);
      const created = await api().createProject({
        ...(title ? { title } : {}), ...(lang ? { lang } : {}), ...(autonomy ? { autonomy } : {}),
        files: local.map(({ name, size }) => ({ name, size })),
      });
      const projectId = created.project.id;
      const names = await api().uploadProjectFiles(projectId, created.uploads ?? [], local);
      const sent = await api().sendProjectMessage(projectId, request, names);
      return text({ project_id: projectId, after_seq: sent.seq, files: names, note: WAIT_NOTE });
    } catch (cause) {
      return failure(cause);
    }
  },
);

server.registerTool(
  'get_project',
  {
    title: 'Look at a research project',
    annotations: { readOnlyHint: true },
    description:
      'Where a research project stands: its state (queued, working, input_required, completed, failed, cancelled, ' +
      "rejected), what it needs from the user, the scoping questions or the plan, the agents' last message, " +
      'deliveries, credits used, and the actions allowed now. Free.',
    inputSchema: {
      project_id: z.string().describe('The project id start_project returned'),
    },
  },
  async ({ project_id }) => {
    try {
      return text(await describeProject(await api().getProject(project_id)));
    } catch (cause) {
      return failure(cause);
    }
  },
);

server.registerTool(
  'wait_for_project',
  {
    title: 'Wait for a research project',
    annotations: { readOnlyHint: true },
    description:
      'Wait until a research project needs the user or has finished (its state is no longer queued or working), up to ' +
      'wait_seconds, then say where it stands as get_project does. Free. If it is still working, call it again ' +
      'with the after_seq it returns.',
    inputSchema: {
      project_id: z.string().describe('The project id'),
      after_seq: z.number().int().nonnegative().optional()
        .describe('The after_seq the last call returned (start_project, message_project, act_on_project or this)'),
      wait_seconds: z.number().optional().describe(`How long to wait (default ${DEFAULT_WAIT_SECONDS}, at most ${MAX_WAIT_SECONDS})`),
    },
  },
  async ({ project_id, after_seq, wait_seconds }) => {
    try {
      const waitMs = Math.min(Math.max(wait_seconds ?? DEFAULT_WAIT_SECONDS, 0), MAX_WAIT_SECONDS) * 1000;
      const { project, next_after } = await api().waitForProject(project_id, after_seq, waitMs);
      const picture = await describeProject(project);
      return text(isBusy(project.state)
        ? { ...picture, after_seq: next_after ?? after_seq, note: 'Still working - call wait_for_project again.' }
        : picture);
    } catch (cause) {
      return failure(cause);
    }
  },
);

server.registerTool(
  'act_on_project',
  {
    title: 'Act on a research project',
    annotations: { readOnlyHint: false, destructiveHint: false },
    description:
      "Take one of the project's allowed_actions, with the ids it names: confirm_plan (spec_version; starts the " +
      'paid work - only once the user agreed to the plan; it is charged by what it uses), answer (answers: question id -> ' +
      'answer), top_up (pause_id; max_credits raises a credit cap that ran out), one_more_round, accept_as_is, ' +
      'pause, resume, cancel, feedback (version, value), deliver_now (the agents read the waiting messages at once, ' +
      'interrupting the step they are on). COSTS CREDITS for confirm_plan, top_up, one_more_round and the scoping ' +
      'answers.',
    inputSchema: {
      project_id: z.string().describe('The project id'),
      action: z.enum(['confirm_plan', 'answer', 'top_up', 'one_more_round', 'accept_as_is', 'pause', 'resume',
        'cancel', 'feedback', 'extend_retention', 'deliver_now']).describe('One of the allowed_actions get_project listed'),
      spec_version: z.number().int().positive().optional().describe('confirm_plan: the plan version shown to the user'),
      pause_id: z.string().optional().describe('top_up: the pause it continues'),
      answers: z.record(z.string()).optional().describe('answer: question id -> answer'),
      max_credits: z.number().int().positive().optional()
        .describe('confirm_plan, top_up, one_more_round: a higher credit cap for the whole project, agreed by the user'),
      version: z.number().int().positive().optional().describe('feedback: the delivered version'),
      value: z.enum(['satisfied', 'needs_changes']).optional().describe('feedback: the verdict'),
      text: z.string().optional().describe('feedback: what to change'),
    },
  },
  async ({ project_id, ...body }) => {
    try {
      const fields = Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined));
      const answer = await api().actOnProject(project_id, fields);
      const works = ['confirm_plan', 'answer', 'top_up', 'one_more_round', 'resume'].includes(body.action);
      return text({ project_id, done: body.action, after_seq: answer.seq, ...(works ? { note: WAIT_NOTE } : {}) });
    } catch (cause) {
      return failure(cause);
    }
  },
);

server.registerTool(
  'message_project',
  {
    title: 'Message a research project',
    annotations: { readOnlyHint: false, destructiveHint: false },
    description:
      "Write to a project's agents, with local files if any: answer in the user's own words, add context, or " +
      'after a delivery ask for changes (a new round). While they work, they read it after the step they are on ' +
      '(usually seconds); deliver_now hands it over at once, interrupting that step. COSTS CREDITS: the turns it ' +
      'starts are charged by use.',
    inputSchema: {
      project_id: z.string().describe('The project id'),
      text: z.string().min(1).describe('The message, in the user\'s words'),
      files: z.array(z.string()).optional().describe('Absolute paths of files to add with it'),
      deliver_now: z.boolean().optional()
        .describe('Interrupt the step the agents are on so they read it at once (urgent corrections only)'),
    },
  },
  async ({ project_id, text: message, files, deliver_now }) => {
    try {
      let names: string[] = [];
      if (files?.length) {
        const local = await api().describeFiles(files);
        const targets = await api().addProjectUploads(project_id, local.map(({ name, size }) => ({ name, size })));
        names = await api().uploadProjectFiles(project_id, targets.uploads ?? [], local);
      }
      const sent = await api().sendProjectMessage(project_id, message, names, deliver_now === true);
      return text({ project_id, after_seq: sent.seq, files: names, note: WAIT_NOTE });
    } catch (cause) {
      return failure(cause);
    }
  },
);

server.registerTool(
  'download_delivery',
  {
    title: 'Download a research project delivery',
    annotations: { readOnlyHint: false, destructiveHint: false },
    description:
      'Save a delivered version of a research project (the latest unless version is given) as a zip in a ' +
      'directory, and return its path. Free.',
    inputSchema: {
      project_id: z.string().describe('The project id'),
      directory: z.string().describe('Absolute path of the directory to save the zip in'),
      version: z.number().int().positive().optional().describe('The delivered version; the latest by default'),
    },
  },
  async ({ project_id, directory, version }) => {
    try {
      const { deliveries } = await api().listProjectDeliveries(project_id);
      const chosen = version ? deliveries.find((item) => item.version === version) : deliveries.at(-1);
      if (!chosen) {
        return failure(new HumanPenError(version ? `no delivered version ${version}` : 'nothing delivered yet',
          'NO_DELIVERY'));
      }
      await mkdir(directory, { recursive: true });
      const saved = await api().downloadProjectDelivery(project_id, chosen.version,
        join(directory, `project-${project_id.slice(0, 8)}-v${chosen.version}.zip`));
      return text({ project_id, version: chosen.version, files: chosen.files, path: saved.path, bytes: saved.bytes });
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
