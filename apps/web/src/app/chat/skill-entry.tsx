/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase";
import { trpc } from "@/trpc/client";
import { AppHeader } from "@/components/layout/AppHeader";
import { ChatSidebar } from "@/components/chat/ChatSidebar";
import { Button } from "@/components/ui/button";
import { SkillConversation } from "./skill-conversation";
import { StandardConversation } from "./standard-conversation";
export function ChatEntry() {
  const params = useSearchParams(),
    router = useRouter();
  const [ownedOrdinary, setOwnedOrdinary] = useState<{ id: string; moduleId?: string; key: string } | null>(null);
  const [identityChanged, setIdentityChanged] = useState(false);
  useEffect(() => {
    let previous: string | null | undefined;
    const {
      data: { subscription },
    } = createClient().auth.onAuthStateChange((_event, session) => {
      const current = session?.user.id ?? null;
      if (previous !== undefined && previous !== current) {
        setIdentityChanged(true);
        window.location.replace(current ? "/chat" : "/login?redirect=/chat");
      }
      previous = current;
    });
    return () => subscription.unsubscribe();
  }, []);
  const conversationId = params.get("conversation") ?? undefined,
    moduleId = params.get("module") ?? undefined;
  const guided = params.get("mode") === "skill";
  const entrySignature = JSON.stringify([conversationId, moduleId, guided]);
  const [entryLocation, setEntryLocation] = useState({ signature: entrySignature, sequence: 0 });
  // Header links and browser navigation do not call navigate(). Give a fresh
  // entry a new component identity while init -> conversation keeps its key.
  if (entryLocation.signature !== entrySignature)
    setEntryLocation({ signature: entrySignature, sequence: entryLocation.sequence + (conversationId ? 0 : 1) });
  const entryKey = `ordinary-${entryLocation.sequence}-${moduleId ?? "free"}`;
  const navigate = (id?: string) => {
    setOwnedOrdinary(null);
    router.push(id ? `/chat?conversation=${encodeURIComponent(id)}` : "/chat");
  };
  const persistOrdinary = (id: string) => {
    setOwnedOrdinary({ id, moduleId, key: entryKey });
    router.replace(`/chat?conversation=${encodeURIComponent(id)}`);
  };
  const history = trpc.chat.getConversations.useQuery(undefined, {
    enabled: !!conversationId,
  });
  const mode = trpc.workbench.chatMode.useQuery(
    { moduleId: moduleId ?? "" },
    { enabled: !!moduleId && !conversationId, retry: false },
  );
  const conversation = history.data?.data.find((c) => c.id === conversationId);
  if (identityChanged) return <EntryNotice>正在切换账号…</EntryNotice>;
  // An init event must update the URL immediately without replacing the active
  // stream component. Only this server-created, in-memory identity gets this path;
  // URL/history entries still use the authenticated history lookup below.
  if (ownedOrdinary && conversationId === ownedOrdinary.id)
    return <StandardConversation key={ownedOrdinary.key} moduleId={ownedOrdinary.moduleId}
      initialConversationId={ownedOrdinary.id} navigate={navigate} onCreated={persistOrdinary} />;
  if (conversationId) {
    if (history.isPending) return <PreparingConversation navigate={navigate} />;
    if (history.error || !conversation)
      return <EntryNotice>对话不可用，请从聊天记录重新选择。</EntryNotice>;
    return conversation.skill_mode ? (
      <SkillConversation
        key={conversationId}
        conversationId={conversationId}
        navigate={navigate}
      />
    ) : (
      <StandardConversation
        key={conversationId}
        initialConversationId={conversationId}
        moduleId={conversation.module_id ?? undefined}
        onCreated={persistOrdinary}
        navigate={navigate}
      />
    );
  }
  if (moduleId && mode.isPending)
    return <PreparingConversation navigate={navigate} />;
  if (moduleId && mode.error)
    return (
      <EntryNotice>
        {mode.error.message} <a href="/chat">打开自由对话</a>
      </EntryNotice>
    );
  if (guided && !moduleId) return <MarketplaceRedirect />;
  if (mode.data?.guided)
    return (
      <SkillPicker
        key={moduleId ?? "catalog"}
        moduleId={moduleId}
        navigate={navigate}
      />
    );
  return (
    <StandardConversation
      key={entryKey}
      moduleId={moduleId}
      onCreated={persistOrdinary}
      navigate={navigate}
    />
  );
}
function MarketplaceRedirect() {
  const router = useRouter();
  useEffect(() => { router.replace("/marketplace"); }, [router]);
  return <EntryNotice>正在打开功能广场…</EntryNotice>;
}
function EntryNotice({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-[var(--bg-primary)] text-[var(--text-primary)]">
      <AppHeader />
      <main className="p-8" role="status">
        {children}
      </main>
    </div>
  );
}
function SkillPicker({
  moduleId,
  navigate,
}: {
  moduleId?: string;
  navigate: (id?: string) => void;
}) {
  const utils = trpc.useUtils(),
    catalog = trpc.workbench.catalog.useQuery(moduleId ? {moduleId} : undefined, { retry: false });
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const requestIds = useRef(new Map<string, string>()),
    entering = useRef(false),
    mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const entries = (catalog.data ?? []).filter(
    (e) => !moduleId || e.moduleId === moduleId,
  );
  const enter = async (
    selected: string,
    registration: string,
    account?: string,
  ) => {
    if (entering.current) return;
    entering.current = true;
    setBusy(true);
    setError("");
    const key = JSON.stringify([selected, registration, account]),
      requestId = requestIds.current.get(key) ?? crypto.randomUUID();
    requestIds.current.set(key, requestId);
    try {
      const result = await utils.client.workbench.chatEnter.mutate({
        moduleId: selected,
        registration,
        account,
        requestId,
      });
      await utils.chat.getConversations.invalidate();
      if (mounted.current) navigate(result.conversationId);
    } catch (e) {
      if (mounted.current) {
        setError(e instanceof Error ? e.message : "Skill 暂时不可用");
        setBusy(false);
      }
      entering.current = false;
    }
  };
  const selectedEntry = [...entries].sort((a, b) => b.workflow.version - a.workflow.version)[0];
  useEffect(() => {
    if (!moduleId || !catalog.data || entering.current) return;
    const entry = selectedEntry;
    if (
      entry &&
      (entry.workflow.kind !== "social" || entry.accounts.length === 1)
    )
      void enter(
        entry.moduleId,
        entry.id,
        entry.workflow.kind === "social" ? entry.accounts[0] : undefined,
      );
  }, [moduleId, catalog.data]);
  const automaticEntry = !!moduleId && !error && !catalog.error &&
    (catalog.isPending || (selectedEntry && (selectedEntry.workflow.kind !== "social" || selectedEntry.accounts.length === 1)));
  if (automaticEntry) return <PreparingConversation title={selectedEntry?.label} navigate={navigate} />;
  return (
    <div className="flex h-screen flex-col bg-[var(--bg-primary)] text-[var(--text-primary)]">
      <AppHeader />
      <div className="flex min-h-0 flex-1">
        <ChatSidebar
          onNewChat={() => navigate()}
          onSelectConversation={navigate}
        />
        <main className="flex-1 overflow-y-auto p-6">
          <h1 className="text-xl font-semibold">{busy ? "正在打开功能对话…" : "开始使用功能"}</h1>
          <p className="my-3 text-[var(--text-tertiary)]">
            选择后将直接进入对话。
          </p>
          {(error || catalog.error) && (
            <p role="alert">
              {error || catalog.error?.message}
            </p>
          )}
          {catalog.isPending && <p>正在读取可用方法…</p>}
          {!catalog.isPending && !entries.length && (
            <p>当前没有可用的引导方法，请检查模块配置。</p>
          )}
          {entries.map((e) => (
            <section
              key={e.id}
              className="mb-4 rounded-xl border border-[var(--border-primary)] p-4"
            >
              <h2>{e.label}</h2>
              <p>{e.workflow.steps.length} 个步骤</p>
              {e.workflow.kind === "social" ? (
                e.accounts.map((account) => (
                  <Button
                    key={account}
                    disabled={busy}
                    className="mr-2 mt-3"
                    onClick={() => void enter(e.moduleId, e.id, account)}
                  >
                    使用 · {account}
                  </Button>
                ))
              ) : (
                <Button
                  disabled={busy}
                  className="mt-3"
                  onClick={() => void enter(e.moduleId, e.id)}
                >
                  使用此 Skill
                </Button>
              )}
              {e.workflow.kind === "social" && !e.accounts.length && (
                <p>尚无可用账号，请先完成账号配置。</p>
              )}
            </section>
          ))}
          <Button variant="outline" disabled={busy} onClick={() => navigate()}>
            自由对话
          </Button>
          <a className="ml-4 underline" href="/workbench">
            找回已有项目与正式报告
          </a>
        </main>
      </div>
    </div>
  );
}

function PreparingConversation({ title, navigate }: { title?: string; navigate: (id?: string) => void }) {
  return (
    <div className="flex h-screen flex-col bg-[var(--bg-primary)] text-[var(--text-primary)]">
      <AppHeader />
      <div className="flex min-h-0 flex-1">
        <ChatSidebar onNewChat={() => navigate()} onSelectConversation={navigate} />
        <main className="flex flex-1 flex-col" aria-label="Skill 对话" aria-busy="true">
          <header className="border-b border-[var(--border-primary)] p-4"><h1>{title ?? "功能对话"}</h1></header>
          <div className="flex-1 p-6" role="status">正在准备对话…</div>
          <div className="border-t border-[var(--border-primary)] p-4"><textarea disabled aria-label="给当前步骤发消息" placeholder="对话准备好后，即可开始讨论…" className="w-full rounded-lg bg-[var(--bg-secondary)] p-3" /></div>
        </main>
      </div>
    </div>
  );
}
