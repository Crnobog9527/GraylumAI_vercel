/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { DraftRow } from '@/components/opc/draft-row';
import { RailGroup, RailHistory, RailView } from '@/components/opc/rail-view';
import takeover from '@/components/landing/preview-j/takeover-j.module.css';
import { J_PERSONA } from '@/lib/landing/landing-copy-j-persona';
import { cn } from '@/lib/utils';
import styles from './picture-l.module.css';

const noop = () => undefined;

/**
 * The work rail of the landing page's product pictures, the product's own (round nine: #1092 made it a display
 * component, RailView with RailHistory and RailGroup; "能用真组件就不用仿制件"), in place of sample J's drawn copy. Same
 * content as before: the work functions (发布排期 and 数据复盘 shown as available, `launched`) and the person's positioning
 * under 待归类. A picture: the wrapper is inert, so its links lead nowhere from the landing page; the picture's frame
 * places it and hides it on a phone, as before.
 */
export function RailL({ published }: { published: boolean }) {
  return (
    <div className={cn(takeover.rail, styles.railHost)} inert>
      <RailView area="chat" launched>
        <RailHistory archiveView={false}>
          <RailGroup title="待归类" open>
            <DraftRow draft={{ draftId: 'sample', businessName: J_PERSONA.account, state: published ? 'published' : 'draft' }}
              menuOpen={false} menuPosition={{}} onOpenMenu={noop} onCloseMenu={noop} onDeleteConversation={noop} onDeleteDraft={noop} />
          </RailGroup>
        </RailHistory>
      </RailView>
    </div>
  );
}
