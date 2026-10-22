/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type {ResearchToolsConfig} from '../research/vendors/config';

export type ResearchRejectionReason =
  | 'CONFIG_DISABLED' | 'CONFIG_MISSING' | 'CONFIG_UNAVAILABLE' | 'CALL_LIMIT' | 'TOOL_LIMIT' | 'MESSAGE_LIMIT'
  | 'BILLING_PROFILE_UNAVAILABLE' | 'PRICE_CONFIG_UNAVAILABLE' | 'THRESHOLD_CONFIG_UNAVAILABLE'
  | 'NO_ELIGIBLE_TOOLS' | 'REQUIRED_TOOLS_UNAVAILABLE' | 'CONTEXT_CAPACITY';
export type ResearchRouteRejection = 'VENDOR_DISABLED' | 'PLATFORM_UNVERIFIED' | 'WINDOW_POLICY_MISSING'
  | 'PRICE_UNAVAILABLE' | 'WINDOW_PRICE_MISMATCH' | 'PRICE_EXPIRES_BEFORE_DEADLINE'
  | 'MULTIPLIER_EXCEEDS_WINDOW' | 'START_THRESHOLD_MISSING_OR_DUPLICATE';
type Route = ResearchToolsConfig['routes'][number];
/** Only fixed enums and counts: no route URLs, prices, user text, settings blobs or exception messages. */
export interface ResearchAdmissionRejection {
  reason: ResearchRejectionReason;
  configRevision?: number;
  configuredRoutes?: number;
  pricedRoutes?: number;
  missingBenchmarkRoutes?: Array<{platform: Route['platform']; kind: Route['kind']}>;
  modelCalls?: number;
  subcalls?: number;
  offeredTools?: number;
  maxTools?: number;
  requiredTools?: number;
  eligibleTools?: number;
  requiredMessages?: number;
  maxMessages?: number;
  routes?: Array<Pick<Route, 'vendor' | 'platform' | 'kind'> & {reason: ResearchRouteRejection}>;
}
export type ResearchRejectionObserver = (rejection: ResearchAdmissionRejection) => void;
