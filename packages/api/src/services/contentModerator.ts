/**
 * Content Moderator
 *
 * 内容审核服务
 * 检测输入/输出中的敏感内容、Prompt 注入攻击等
 */

// ============================================
// 常量
// ============================================

/**
 * 审核严格程度
 */
export const ModerationLevel = {
  LOW: 'low',       // 仅检测严重违规
  MEDIUM: 'medium', // 默认级别
  HIGH: 'high',     // 严格模式
} as const;

export type ModerationLevel = typeof ModerationLevel[keyof typeof ModerationLevel];

/**
 * 违规类型
 */
export const ViolationType = {
  PROMPT_INJECTION: 'prompt_injection',
  JAILBREAK: 'jailbreak',
  HARMFUL_CONTENT: 'harmful_content',
  PII_LEAK: 'pii_leak',
  SPAM: 'spam',
  MALICIOUS_CODE: 'malicious_code',
  SENSITIVE_TOPIC: 'sensitive_topic',
} as const;

export type ViolationType = typeof ViolationType[keyof typeof ViolationType];

// ============================================
// 检测规则
// ============================================

/**
 * Prompt 注入检测模式
 */
const PROMPT_INJECTION_PATTERNS = [
  // 直接指令覆盖
  /忽略[之前所有|以上|上述|前面的?][指令|提示|规则|约束]/i,
  /ignore\s+(all\s+)?(previous|above|prior)\s+(instructions?|prompts?|rules?)/i,
  /disregard\s+(all\s+)?(previous|above)/i,

  // 角色扮演逃逸
  /你现在是|你是一个|扮演|假装你是|pretend\s+you\s+are/i,
  /from\s+now\s+on\s+you\s+are/i,
  /act\s+as\s+(if\s+you\s+are|a)/i,

  // 系统提示词泄露
  /告诉我你的系统提示词|显示你的指令|你的规则是什么/i,
  /what\s+are\s+your\s+(system\s+)?instructions/i,
  /show\s+(me\s+)?your\s+(system\s+)?prompt/i,
  /reveal\s+your\s+(hidden\s+)?instructions/i,

  // DAN (Do Anything Now) 类攻击
  /\bDAN\b|\bJailbreak\b/i,
  /developer\s+mode|god\s+mode/i,

  // 格式操控
  /\[SYSTEM\]|\[INST\]|\<\|im_start\|>/i,
  /###\s*(System|User|Assistant)\s*:/i,
];

/**
 * 有害内容检测模式
 */
const HARMFUL_CONTENT_PATTERNS = [
  // 暴力相关
  /如何[制作|制造|组装][炸弹|武器|枪支|毒品]/i,
  /how\s+to\s+(make|build|create)\s+(a\s+)?(bomb|weapon|drug)/i,

  // 非法活动
  /如何[入侵|黑客|破解|盗取]/i,
  /how\s+to\s+(hack|crack|steal|bypass)/i,

  // 自我伤害
  /自杀方法|如何结束生命/i,
  /suicide\s+methods?|how\s+to\s+end\s+(my\s+)?life/i,
];

/**
 * PII (个人身份信息) 检测模式
 */
const PII_PATTERNS = [
  // 身份证号
  /\b\d{6}(19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b/,

  // 手机号
  /\b1[3-9]\d{9}\b/,

  // 银行卡号
  /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/,

  // 邮箱 (输出时可能需要脱敏)
  /[\w.-]{1,254}@[\w.-]{1,254}\.\w{2,63}/i,

  // API Key 模式
  /\b(sk-|pk-|api[_-]?key|secret[_-]?key)[a-zA-Z0-9]{20,4096}\b/i,

  // JWT Token
  /eyJ[a-zA-Z0-9_-]{1,8192}\.eyJ[a-zA-Z0-9_-]{1,8192}\.[a-zA-Z0-9_-]{1,8192}/,
];

/**
 * 恶意代码检测模式
 */
const MALICIOUS_CODE_PATTERNS: RegExp[] = [
  // SQL 注入
  /(\b(SELECT|INSERT|UPDATE|DELETE|DROP|UNION)\b.{0,100000}\b(FROM|INTO|SET|WHERE)\b)/i,
  /(['"];\s{0,64}(DROP|DELETE|UPDATE|INSERT)\s{1,64})/i,

  // XSS
  /javascript:/i,
  /on(load|error|click|mouse)\s*=/i,

  // 命令注入
  /[;&|]\s*(rm|del|format|shutdown|reboot)\s/i,
  /\$\([^)]+\)|\`[^`]+\`/,
];

function findScriptElement(content: string): { match: string; index: number } | undefined {
  const lowerContent = content.toLowerCase();
  const openingIndex = lowerContent.indexOf('<script');
  if (openingIndex === -1) return undefined;

  const openingEnd = lowerContent.indexOf('>', openingIndex + '<script'.length);
  if (openingEnd === -1) return undefined;

  const closingIndex = lowerContent.indexOf('</script>', openingEnd + 1);
  if (closingIndex === -1) return undefined;

  const end = closingIndex + '</script>'.length;
  return { match: content.slice(openingIndex, end), index: openingIndex };
}

// ============================================
// 类型定义
// ============================================

export interface ModerationResult {
  passed: boolean;
  violations: Violation[];
  riskScore: number; // 0-100
  suggestions?: string[];
}

export interface Violation {
  type: ViolationType;
  severity: 'low' | 'medium' | 'high' | 'critical';
  message: string;
  matchedPattern?: string;
  position?: { start: number; end: number };
}

export interface ModerationConfig {
  level: ModerationLevel;
  enablePromptInjectionCheck: boolean;
  enableHarmfulContentCheck: boolean;
  enablePIICheck: boolean;
  enableMaliciousCodeCheck: boolean;
  customPatterns?: Array<{
    type: ViolationType;
    pattern: RegExp;
    severity: Violation['severity'];
    message: string;
  }>;
}

// ============================================
// Content Moderator 类
// ============================================

export class ContentModerator {
  private config: ModerationConfig;

  constructor(config: Partial<ModerationConfig> = {}) {
    this.config = {
      level: config.level ?? ModerationLevel.MEDIUM,
      enablePromptInjectionCheck: config.enablePromptInjectionCheck ?? true,
      enableHarmfulContentCheck: config.enableHarmfulContentCheck ?? true,
      enablePIICheck: config.enablePIICheck ?? true,
      enableMaliciousCodeCheck: config.enableMaliciousCodeCheck ?? true,
      customPatterns: config.customPatterns ?? [],
    };
  }

  /**
   * 审核输入内容
   */
  moderateInput(content: string): ModerationResult {
    const violations: Violation[] = [];

    // 1. Prompt 注入检测
    if (this.config.enablePromptInjectionCheck) {
      violations.push(...this.checkPromptInjection(content));
    }

    // 2. 有害内容检测
    if (this.config.enableHarmfulContentCheck) {
      violations.push(...this.checkHarmfulContent(content));
    }

    // 3. 恶意代码检测
    if (this.config.enableMaliciousCodeCheck) {
      violations.push(...this.checkMaliciousCode(content));
    }

    // 4. 自定义规则
    violations.push(...this.checkCustomPatterns(content));

    return this.buildResult(violations);
  }

  /**
   * 审核输出内容
   */
  moderateOutput(content: string): ModerationResult {
    const violations: Violation[] = [];

    // 1. PII 泄露检测
    if (this.config.enablePIICheck) {
      violations.push(...this.checkPIILeak(content));
    }

    // 2. 有害内容检测 (输出也需要检查)
    if (this.config.enableHarmfulContentCheck) {
      violations.push(...this.checkHarmfulContent(content));
    }

    // 3. 自定义规则
    violations.push(...this.checkCustomPatterns(content));

    return this.buildResult(violations);
  }

  /**
   * 检测 Prompt 注入
   */
  private checkPromptInjection(content: string): Violation[] {
    const violations: Violation[] = [];

    for (const pattern of PROMPT_INJECTION_PATTERNS) {
      const match = content.match(pattern);
      if (match) {
        violations.push({
          type: ViolationType.PROMPT_INJECTION,
          severity: 'high',
          message: '检测到可能的 Prompt 注入攻击',
          matchedPattern: match[0],
          position: match.index !== undefined
            ? { start: match.index, end: match.index + match[0].length }
            : undefined,
        });
      }
    }

    return violations;
  }

  /**
   * 检测有害内容
   */
  private checkHarmfulContent(content: string): Violation[] {
    const violations: Violation[] = [];

    for (const pattern of HARMFUL_CONTENT_PATTERNS) {
      const match = content.match(pattern);
      if (match) {
        violations.push({
          type: ViolationType.HARMFUL_CONTENT,
          severity: 'critical',
          message: '检测到可能的有害内容',
          matchedPattern: match[0],
          position: match.index !== undefined
            ? { start: match.index, end: match.index + match[0].length }
            : undefined,
        });
      }
    }

    return violations;
  }

  /**
   * 检测 PII 泄露
   */
  private checkPIILeak(content: string): Violation[] {
    const violations: Violation[] = [];

    for (const pattern of PII_PATTERNS) {
      const match = content.match(pattern);
      if (match) {
        violations.push({
          type: ViolationType.PII_LEAK,
          severity: 'medium',
          message: '检测到可能的个人身份信息',
          matchedPattern: this.maskPII(match[0]),
          position: match.index !== undefined
            ? { start: match.index, end: match.index + match[0].length }
            : undefined,
        });
      }
    }

    return violations;
  }

  /**
   * 检测恶意代码
   */
  private checkMaliciousCode(content: string): Violation[] {
    const scriptMatch = findScriptElement(content);
    const patternViolations: Violation[] = [];

    const appendPatternViolations = (patterns: RegExp[]): void => {
      for (const pattern of patterns) {
        const match = content.match(pattern);
        if (match) {
          patternViolations.push({
            type: ViolationType.MALICIOUS_CODE,
            severity: 'high',
            message: '检测到可能的恶意代码',
            matchedPattern: match[0].substring(0, 50) + (match[0].length > 50 ? '...' : ''),
            position: match.index !== undefined
              ? { start: match.index, end: match.index + match[0].length }
              : undefined,
          });
        }
      }
    };

    appendPatternViolations(MALICIOUS_CODE_PATTERNS.slice(0, 2));

    if (scriptMatch) {
      patternViolations.push({
        type: ViolationType.MALICIOUS_CODE,
        severity: 'high',
        message: '检测到可能的恶意代码',
        matchedPattern: scriptMatch.match.substring(0, 50) + (scriptMatch.match.length > 50 ? '...' : ''),
        position: { start: scriptMatch.index, end: scriptMatch.index + scriptMatch.match.length },
      });
    }

    appendPatternViolations(MALICIOUS_CODE_PATTERNS.slice(2));

    return patternViolations;
  }

  /**
   * 检查自定义规则
   */
  private checkCustomPatterns(content: string): Violation[] {
    const violations: Violation[] = [];

    for (const rule of this.config.customPatterns ?? []) {
      const match = content.match(rule.pattern);
      if (match) {
        violations.push({
          type: rule.type,
          severity: rule.severity,
          message: rule.message,
          matchedPattern: match[0],
          position: match.index !== undefined
            ? { start: match.index, end: match.index + match[0].length }
            : undefined,
        });
      }
    }

    return violations;
  }

  /**
   * 构建审核结果
   */
  private buildResult(violations: Violation[]): ModerationResult {
    // 计算风险分数
    const riskScore = this.calculateRiskScore(violations);

    // 根据审核级别判断是否通过
    const passed = this.shouldPass(violations, riskScore);

    // 生成建议
    const suggestions = this.generateSuggestions(violations);

    return {
      passed,
      violations,
      riskScore,
      suggestions: suggestions.length > 0 ? suggestions : undefined,
    };
  }

  /**
   * 计算风险分数
   */
  private calculateRiskScore(violations: Violation[]): number {
    if (violations.length === 0) return 0;

    const severityScores: Record<Violation['severity'], number> = {
      low: 10,
      medium: 25,
      high: 50,
      critical: 100,
    };

    const totalScore = violations.reduce(
      (sum, v) => sum + severityScores[v.severity],
      0
    );

    return Math.min(100, totalScore);
  }

  /**
   * 判断是否通过审核
   */
  private shouldPass(violations: Violation[], riskScore: number): boolean {
    // 有任何严重违规直接不通过
    if (violations.some((v) => v.severity === 'critical')) {
      return false;
    }

    // 根据审核级别判断
    switch (this.config.level) {
      case ModerationLevel.LOW:
        return riskScore < 80;
      case ModerationLevel.MEDIUM:
        return riskScore < 50;
      case ModerationLevel.HIGH:
        return riskScore < 25;
      default:
        return riskScore < 50;
    }
  }

  /**
   * 生成改进建议
   */
  private generateSuggestions(violations: Violation[]): string[] {
    const suggestions: string[] = [];

    const hasInjection = violations.some((v) => v.type === ViolationType.PROMPT_INJECTION);
    const hasPII = violations.some((v) => v.type === ViolationType.PII_LEAK);
    const hasHarmful = violations.some((v) => v.type === ViolationType.HARMFUL_CONTENT);

    if (hasInjection) {
      suggestions.push('请避免使用可能被解读为指令覆盖的表述');
    }

    if (hasPII) {
      suggestions.push('请移除或脱敏个人身份信息');
    }

    if (hasHarmful) {
      suggestions.push('请修改内容以符合使用政策');
    }

    return suggestions;
  }

  /**
   * 脱敏 PII
   */
  private maskPII(pii: string): string {
    if (pii.length <= 4) return '****';
    return pii.substring(0, 2) + '*'.repeat(pii.length - 4) + pii.substring(pii.length - 2);
  }

  /**
   * 清理内容中的敏感信息
   */
  sanitize(content: string): string {
    let sanitized = content;

    // 清理 PII
    for (const pattern of PII_PATTERNS) {
      sanitized = sanitized.replace(pattern, (match) => this.maskPII(match));
    }

    return sanitized;
  }
}

/**
 * 默认实例
 */
export const defaultModerator = new ContentModerator();

/**
 * 快速审核输入
 */
export function moderateInput(
  content: string,
  level: ModerationLevel = ModerationLevel.MEDIUM
): ModerationResult {
  const moderator = new ContentModerator({ level });
  return moderator.moderateInput(content);
}

/**
 * 快速审核输出
 */
export function moderateOutput(
  content: string,
  level: ModerationLevel = ModerationLevel.MEDIUM
): ModerationResult {
  const moderator = new ContentModerator({ level });
  return moderator.moderateOutput(content);
}

export default ContentModerator;
