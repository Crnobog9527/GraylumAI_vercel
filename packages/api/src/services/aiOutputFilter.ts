import { checkOutputSecurity, sanitizeOutputSecurity } from '../middleware/securityChecks';
import { defaultModerator, ViolationType } from './contentModerator';

export const BLOCKED_AI_OUTPUT_MESSAGE = '抱歉，该回复包含受限内容，已被安全策略拦截。请换个问题重试。';

export interface FilteredAIOutput {
  content: string;
  blocked: boolean;
  sanitized: boolean;
  reasons: string[];
}

function uniqueReasons(reasons: string[]): string[] {
  return Array.from(new Set(reasons.filter(Boolean)));
}

export function filterAIOutput(content: string): FilteredAIOutput {
  const moderation = defaultModerator.moderateOutput(content);
  const moderationReasons = moderation.violations.map((violation) => violation.type);
  const hasSensitiveLeak = !checkOutputSecurity(content);
  const hasPIILeak = moderation.violations.some(
    (violation) => violation.type === ViolationType.PII_LEAK
  );
  const hasHarmfulContent = moderation.violations.some(
    (violation) => violation.type === ViolationType.HARMFUL_CONTENT
  );

  if (hasHarmfulContent) {
    return {
      content: BLOCKED_AI_OUTPUT_MESSAGE,
      blocked: true,
      sanitized: false,
      reasons: uniqueReasons(moderationReasons),
    };
  }

  if (moderation.passed && !hasSensitiveLeak && !hasPIILeak) {
    return {
      content,
      blocked: false,
      sanitized: false,
      reasons: [],
    };
  }

  const sanitizedContent = sanitizeOutputSecurity(defaultModerator.sanitize(content));

  if (!checkOutputSecurity(sanitizedContent)) {
    return {
      content: BLOCKED_AI_OUTPUT_MESSAGE,
      blocked: true,
      sanitized: false,
      reasons: uniqueReasons([...moderationReasons, 'sensitive_content']),
    };
  }

  return {
    content: sanitizedContent,
    blocked: false,
    sanitized: sanitizedContent !== content,
    reasons: uniqueReasons([
      ...moderationReasons,
      ...(hasSensitiveLeak ? ['sensitive_content'] : []),
    ]),
  };
}
