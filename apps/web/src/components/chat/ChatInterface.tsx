'use client';

import { useState, useRef, useEffect } from 'react';
import { trpc } from '@/trpc/client';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Send, Loader2, Bot, MessageSquare, Copy, Check } from 'lucide-react';

interface ChatInterfaceProps {
  conversationId: string;
}

// Message Bubble Component
function MessageBubble({
  role,
  content,
  timestamp
}: {
  role: string;
  content: string;
  timestamp?: string;
}) {
  const [copied, setCopied] = useState(false);
  const isUser = role === 'user';

  const handleCopy = async () => {
    await navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // User message with gold gradient
  if (isUser) {
    return (
      <div className="flex justify-end py-4">
        <div className="max-w-[80%] space-y-2">
          <div
            className="rounded-2xl rounded-tr-md px-4 py-3"
            style={{
              background: 'linear-gradient(135deg, hsl(var(--primary)) 0%, hsl(var(--secondary)) 100%)',
              color: 'hsl(var(--primary-foreground))',
            }}
          >
            <p className="whitespace-pre-wrap leading-relaxed font-medium">{content}</p>
          </div>
          {timestamp && (
            <div className="text-xs text-right" style={{ color: 'hsl(var(--muted-foreground))' }}>
              {timestamp}
            </div>
          )}
        </div>
      </div>
    );
  }

  // AI message
  return (
    <div className="flex gap-4 py-4">
      <div
        className="w-9 h-9 rounded-full flex items-center justify-center shrink-0"
        style={{
          background: 'var(--color-primary-10)',
          border: '1px solid var(--color-primary-20)'
        }}
      >
        <Bot className="h-5 w-5" style={{ color: 'hsl(var(--primary))' }} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="prose prose-sm max-w-none prose-invert">
          <p className="leading-relaxed" style={{ color: 'hsl(var(--muted-foreground))' }}>
            {content}
          </p>
        </div>
        <div className="flex items-center gap-4 mt-3 text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>
          {timestamp && <span>{timestamp}</span>}
          {copied && <span style={{ color: '#22C55E' }}>Copied</span>}
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 hover:opacity-80 ml-auto"
            style={{ color: copied ? '#22C55E' : 'hsl(var(--muted-foreground))' }}
            onClick={handleCopy}
          >
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          </Button>
        </div>
      </div>
    </div>
  );
}

// Empty State Component
function EmptyState() {
  return (
    <div className="text-center py-20">
      <div
        className="w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-4"
        style={{
          background: 'var(--color-primary-10)',
          border: '1px solid var(--color-primary-20)'
        }}
      >
        <MessageSquare className="h-8 w-8" style={{ color: 'hsl(var(--primary))' }} />
      </div>
      <h2 className="text-xl font-medium mb-2" style={{ color: 'hsl(var(--foreground))' }}>
        Start a new conversation
      </h2>
      <p style={{ color: 'hsl(var(--muted-foreground))' }}>
        Enter your question below to begin
      </p>
    </div>
  );
}

// Streaming Indicator
function StreamingIndicator() {
  return (
    <div className="flex gap-4 py-4">
      <div
        className="w-9 h-9 rounded-full flex items-center justify-center shrink-0"
        style={{
          background: 'var(--color-primary-10)',
          border: '1px solid var(--color-primary-20)'
        }}
      >
        <Bot className="h-5 w-5" style={{ color: 'hsl(var(--primary))' }} />
      </div>
      <div className="flex items-center gap-2" style={{ color: 'hsl(var(--muted-foreground))' }}>
        <span className="flex gap-1">
          <span
            className="w-2 h-2 rounded-full animate-bounce"
            style={{ background: 'hsl(var(--primary))', animationDelay: '0ms' }}
          />
          <span
            className="w-2 h-2 rounded-full animate-bounce"
            style={{ background: 'hsl(var(--primary))', animationDelay: '150ms' }}
          />
          <span
            className="w-2 h-2 rounded-full animate-bounce"
            style={{ background: 'hsl(var(--primary))', animationDelay: '300ms' }}
          />
        </span>
        <span className="text-sm">AI is thinking...</span>
      </div>
    </div>
  );
}

export function ChatInterface({ conversationId }: ChatInterfaceProps) {
  const { data: messages, isLoading, refetch } = trpc.chat.getMessages.useQuery({ conversationId });
  const sendMessage = trpc.chat.sendMessage.useMutation({
    onSuccess: () => {
      refetch();
      setNewMessage('');
    },
  });
  const [newMessage, setNewMessage] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 120) + 'px';
    }
  }, [newMessage]);

  const handleSend = () => {
    if (newMessage.trim() !== '' && !sendMessage.isPending) {
      sendMessage.mutate({ conversationId, content: newMessage });
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-8 w-8 animate-spin" style={{ color: 'hsl(var(--primary))' }} />
      </div>
    );
  }

  const messageList = messages?.data || [];

  return (
    <div className="flex flex-col h-full" style={{ background: 'hsl(var(--background))' }}>
      {/* Messages Area */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto py-6 px-4">
          {messageList.length === 0 ? (
            <EmptyState />
          ) : (
            messageList.map((msg) => (
              <MessageBubble
                key={msg.id}
                role={msg.role}
                content={msg.content}
              />
            ))
          )}
          {sendMessage.isPending && <StreamingIndicator />}
          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Input Area */}
      <div
        className="p-4"
        style={{
          borderTop: '1px solid hsl(var(--border))',
          background: 'hsl(var(--card))'
        }}
      >
        <div className="max-w-3xl mx-auto">
          <div
            className="relative rounded-2xl"
            style={{
              background: 'hsl(var(--background))',
              border: '1px solid var(--color-primary-20)',
            }}
          >
            <div className="flex items-end p-3">
              <Textarea
                ref={textareaRef}
                value={newMessage}
                onChange={(e) => setNewMessage(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Enter your message..."
                disabled={sendMessage.isPending}
                className="flex-1 min-h-[44px] max-h-[120px] resize-none border-0 focus-visible:ring-0 py-2 px-2 text-base bg-transparent"
                style={{ color: 'hsl(var(--foreground))' }}
                rows={1}
              />
              <div className="flex items-center gap-2 shrink-0">
                <span className="text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>
                  {newMessage.length}/4000
                </span>
                <Button
                  onClick={handleSend}
                  disabled={!newMessage.trim() || sendMessage.isPending}
                  className="h-9 px-5 gap-2 rounded-xl font-medium"
                  style={{
                    background: 'linear-gradient(135deg, hsl(var(--primary)) 0%, hsl(var(--secondary)) 100%)',
                    color: 'hsl(var(--primary-foreground))',
                  }}
                >
                  {sendMessage.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <>
                      Send
                      <Send className="h-4 w-4" />
                    </>
                  )}
                </Button>
              </div>
            </div>
          </div>
          <p className="text-xs text-center mt-3" style={{ color: 'hsl(var(--muted-foreground))' }}>
            Press Enter to send, Shift + Enter for new line
          </p>
        </div>
      </div>
    </div>
  );
}
