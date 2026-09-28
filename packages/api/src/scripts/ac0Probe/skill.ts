/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// AC-0b model probe. Standalone script: application code must never import it.
import {createHash} from 'node:crypto';
import {lstatSync, readdirSync, readFileSync, realpathSync} from 'node:fs';
import {join, posix, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {z} from 'zod';
import {askQuestionArgs} from './classify.ts';

/** Synthetic repository fixture used when no private Skill directory is given. */
export const FIXTURE_SKILL_DIR = fileURLToPath(new URL(
  '../../services/__tests__/fixtures/standard-skills/workshop-notes/v2/workshop-notes', import.meta.url));

const FILE_LIMIT = 262_144;
const REFERENCE_LIMIT = 64;

/** Step fields from the Skill's workflow.yaml (JSON), which the real host supplies per turn. */
const workflowSchema = z.object({
  steps: z.array(z.object({
    title: z.string().min(1).max(200),
    information: z.array(z.object({title: z.string().min(1).max(200), required: z.boolean()}).passthrough()).default([]),
  }).passthrough()).min(1).max(20),
}).passthrough();
export type WorkflowStep = z.infer<typeof workflowSchema>['steps'][number];

export type LoadedSkill = {
  /** Full SKILL.md text. Kept in memory only; never summarized or logged. */
  instructions: string;
  references: ReadonlyMap<string, string>;
  /** Parsed workflow.yaml when the Skill has one. Kept in memory only. */
  workflow?: WorkflowStep[];
  digest: string;
  bytes: number;
  isFixture: boolean;
};

function readRegular(path: string): string {
  const stat = lstatSync(path);
  if (!stat.isFile()) throw new Error('PROBE_SKILL_FILE_INVALID: not a regular file');
  if (stat.size > FILE_LIMIT) throw new Error('PROBE_SKILL_FILE_TOO_LARGE');
  return readFileSync(path, 'utf8');
}

/** Reads SKILL.md and references/ (two levels, no symlinks) once at start. */
export function loadSkill(dir: string | undefined): LoadedSkill {
  const root = realpathSync(resolve(dir ?? FIXTURE_SKILL_DIR));
  if (!lstatSync(root).isDirectory()) throw new Error('PROBE_SKILL_DIR_INVALID');
  const instructions = readRegular(join(root, 'SKILL.md'));
  const references = new Map<string, string>();
  const walk = (relative: string, depth: number) => {
    const absolute = join(root, relative);
    if (depth > 2) return;
    for (const entry of readdirSync(absolute, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = posix.join(relative, entry.name);
      if (entry.isDirectory()) walk(child, depth + 1);
      else if (entry.isFile()) references.set(child, readRegular(join(root, child)));
      else throw new Error('PROBE_SKILL_FILE_INVALID: only regular files and directories');
      if (references.size > REFERENCE_LIMIT) throw new Error('PROBE_SKILL_TOO_MANY_REFERENCES');
    }
  };
  let hasReferences = false;
  try {
    hasReferences = lstatSync(join(root, 'references')).isDirectory();
  } catch { /* optional */ }
  if (hasReferences) walk('references', 1);
  let workflowText: string | undefined;
  try {
    workflowText = readRegular(join(root, 'workflow.yaml'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const workflow = workflowText === undefined ? undefined
    : parsePrivateJson(workflowText, workflowSchema, 'SKILL_WORKFLOW').steps;
  const hash = createHash('sha256').update('SKILL.md\0' + instructions);
  let bytes = Buffer.byteLength(instructions);
  for (const [path, text] of references) {
    hash.update('\0' + path + '\0' + text);
    bytes += Buffer.byteLength(text);
  }
  // Only a Skill with workflow.yaml gets a new digest; other plan ids stay valid.
  if (workflowText !== undefined) hash.update('\0workflow.yaml\0' + workflowText);
  return {
    instructions, references, ...(workflow ? {workflow} : {}), digest: hash.digest('hex').slice(0, 16), bytes,
    isFixture: dir === undefined,
  };
}

/** read_reference accepts only a path the loaded Skill contains. */
export function readReference(skill: LoadedSkill, requested: string): string {
  const normalized = posix.normalize(requested.trim().replace(/^\.\//, ''));
  return skill.references.get(normalized) ?? 'NOT_FOUND: available files are ' + [...skill.references.keys()].join(', ');
}

const message = z.object({role: z.enum(['user', 'assistant']), content: z.string().min(1).max(8000)}).strict();
/** An earlier assistant turn that showed a question card, as the new interaction
 * stores it: optional text, then an ask_question call and its result. The user's
 * choice follows as the next user message (or the scenario input). */
const askTurn = z.object({
  role: z.literal('assistant'),
  content: z.string().min(1).max(8000).optional(),
  askQuestion: askQuestionArgs,
}).strict();
export type HistoryItem = z.infer<typeof message> | z.infer<typeof askTurn>;
export const scenarioSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  kind: z.enum(['ask', 'text', 'reference']),
  history: z.array(z.union([message, askTurn])).max(20).default([]),
  input: z.string().min(1).max(8000),
  /** Index into the Skill's workflow.yaml steps; the probe then gives the model
   * that step's required information, as the real host would. */
  step: z.number().int().min(0).max(19).optional(),
  /** Operator's expectation for later manual labelling of step completion. */
  expectStepComplete: z.boolean().optional(),
}).strict();
export type Scenario = z.infer<typeof scenarioSchema>;

/** Host text for a scenario's current step; empty without a step. Private: it
 * quotes workflow.yaml and travels only in the request instructions. */
export function stepRules(skill: LoadedSkill, step: number | undefined): string {
  if (step === undefined) return '';
  const current = skill.workflow?.[step];
  if (!current) throw new Error('PROBE_SCENARIO_STEP_UNAVAILABLE');
  const required = current.information.filter(item => item.required).map(item => item.title);
  return [
    `Current step: ${current.title}.`,
    `Required information for this step: ${required.join(', ') || 'none'}.`,
    'The step is complete when the user has provided or explicitly deferred every required item.',
    'When it is complete, briefly summarize what the user gave and ask them to confirm this step.',
  ].join('\n');
}
const scenarioFile = z.object({scenarios: z.array(scenarioSchema).min(1).max(100)}).strict();

/** Synthetic scenarios for the fixture Skill. Private Skills need their own file. */
const fixtureScenarios: Scenario[] = [
  {id: 'fixture-ask-open', kind: 'ask', history: [], input: 'I want to run a small community workshop but I do not know where to start.'},
  {
    id: 'fixture-ask-partial', kind: 'ask', expectStepComplete: false,
    history: [
      {role: 'user', content: 'I want to run a small community workshop.'},
      {role: 'assistant', content: 'Happy to help. Who is it for, and roughly how many people?'},
    ],
    input: 'About fifteen neighbours, mostly retired, on a Saturday morning.',
  },
  {
    id: 'fixture-ask-complete', kind: 'ask', expectStepComplete: true,
    history: [
      {role: 'user', content: 'Workshop for fifteen retired neighbours, Saturday 10:00-12:00, library room, no budget.'},
      {role: 'assistant', content: 'Thanks. Is there anything the room cannot provide?'},
    ],
    input: 'No projector, but there is a whiteboard. That is everything I know about the constraints.',
  },
  {id: 'fixture-text', kind: 'text', history: [], input: 'Briefly, why should constraints be gathered before outlining a session?'},
  {id: 'fixture-reference', kind: 'reference', history: [], input: 'Let us start the gather task. What do you need from me?'},
];

/** Parses a private file. Errors name only the failing field and issue code:
 * JSON and schema messages can quote file content, which must not reach a console. */
export function parsePrivateJson<T>(text: string, schema: z.ZodType<T>, label: string): T {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`PROBE_${label}_INVALID: not valid JSON`);
  }
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const where = parsed.error.issues.slice(0, 5).map(issue => (issue.path.join('.') || '(root)') + ' ' + issue.code);
  throw new Error(`PROBE_${label}_INVALID: ${where.join('; ')}`);
}

export function loadScenarios(path: string | undefined, skill: LoadedSkill): {scenarios: Scenario[]; digest: string} {
  let scenarios: Scenario[];
  if (path) scenarios = parsePrivateJson(readRegular(resolve(path)), scenarioFile, 'SCENARIOS').scenarios;
  else if (skill.isFixture) scenarios = fixtureScenarios.map(scenario => scenarioSchema.parse(scenario));
  else throw new Error('PROBE_SCENARIOS_REQUIRED: a private --skill-dir needs --scenarios <file> outside the repository');
  if (new Set(scenarios.map(scenario => scenario.id)).size !== scenarios.length) throw new Error('PROBE_SCENARIO_ID_DUPLICATE');
  for (const scenario of scenarios) {
    // Text trials run without tools, so a replayed tool call would have no definition.
    if (scenario.kind === 'text' && scenario.history.some(item => 'askQuestion' in item)) {
      throw new Error(`PROBE_SCENARIO_TOOL_HISTORY_UNSUPPORTED: ${scenario.id} is a text scenario`);
    }
    if (scenario.step !== undefined && !skill.workflow?.[scenario.step]) {
      throw new Error(`PROBE_SCENARIO_STEP_UNAVAILABLE: ${scenario.id} names a step the Skill's workflow.yaml does not have`);
    }
  }
  const digest = createHash('sha256').update(JSON.stringify(scenarios)).digest('hex').slice(0, 16);
  return {scenarios, digest};
}

export function scenariosOf(scenarios: Scenario[], kind: Scenario['kind']): Scenario[] {
  return scenarios.filter(scenario => scenario.kind === kind);
}
