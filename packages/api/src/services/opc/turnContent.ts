/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { opcContentFromTurn, opcContentManualSave, opcVideoResultsFromTurn } from '../../shared/opcRequests';

/** V2-10b C2: a work item's content saved from a turn or by hand; the rules are in the database. */
export function turnContentService(rpc: (name: string, args: Record<string, unknown>) => unknown) {
  return {
    contentFromTurn: (value: unknown) => {
      const v = opcContentFromTurn.parse(value);
      return rpc('opc_content_from_turn', { p_work_item_id: v.workItemId, p_request_id: v.requestId, p_expected_version: v.expectedVersion,
        p_kind: v.kind, p_status: v.status, p_turn_id: v.turnId, p_source_content_id: v.sourceContentId });
    },
    contentManualSave: (value: unknown) => {
      const v = opcContentManualSave.parse(value);
      return rpc('opc_content_manual_save', {
        p_work_item_id: v.workItemId,
        p_request_id: v.requestId,
        p_expected_version: v.expectedVersion,
        p_source_content_id: v.sourceContentId,
        p_kind: v.kind,
        p_status: v.status,
        p_title: v.title,
        p_body: v.body,
      });
    },
    videoResultsFromTurn: (value: unknown) => {
      const v = opcVideoResultsFromTurn.parse(value);
      return rpc('opc_video_results_from_turn', { p_work_item_id: v.workItemId, p_request_id: v.requestId, p_turn_id: v.turnId,
        p_source_script_id: v.sourceScriptId, p_expected_storyboard_version: v.expectedStoryboardVersion,
        p_expected_editing_version: v.expectedEditingVersion, p_storyboard: v.choice !== 'editing', p_editing: v.choice !== 'storyboard' });
    },
  };
}
