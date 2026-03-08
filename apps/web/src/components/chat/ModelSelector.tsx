'use client';

import React from 'react';
import { Sparkles, Zap, Brain } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface Model {
  id: string;
  name: string;
  provider: string;
  description?: string;
  credits_per_message: number;
  is_active: boolean;
}

interface ModelSelectorProps {
  models: Model[];
  selectedModel: string;
  onSelect: (value: string) => void;
  disabled?: boolean;
}

const providerIcons: Record<string, React.ElementType> = {
  anthropic: Sparkles,
  google: Brain,
  openai: Zap,
  custom: Sparkles
};

const providerColors: Record<string, { bg: string; text: string }> = {
  anthropic: { bg: 'bg-orange-500/10', text: 'text-orange-400' },
  google: { bg: 'bg-blue-500/10', text: 'text-blue-400' },
  openai: { bg: 'bg-emerald-500/10', text: 'text-emerald-400' },
  custom: { bg: 'bg-violet-500/10', text: 'text-violet-400' }
};

export default function ModelSelector({
  models,
  selectedModel,
  onSelect,
  disabled
}: ModelSelectorProps) {
  const selectedModelData = models.find(m => m.id === selectedModel);

  return (
    <Select value={selectedModel} onValueChange={onSelect} disabled={disabled}>
      <SelectTrigger
        data-testid="chat-model-selector-trigger"
        className={cn(
          "w-full h-11 px-3",
          "bg-[var(--bg-secondary)]/80 backdrop-blur-sm",
          "border border-[var(--border-primary)]",
          "hover:border-[var(--border-secondary)] hover:bg-[var(--bg-tertiary)]",
          "transition-all duration-200",
          "text-[var(--text-primary)]"
        )}
      >
        <SelectValue placeholder="选择 AI 模型">
          {selectedModelData && (
            <div className="flex items-center gap-2">
              {React.createElement(providerIcons[selectedModelData.provider] || Sparkles, {
                className: cn(
                  "h-4 w-4",
                  providerColors[selectedModelData.provider]?.text || "text-violet-400"
                )
              })}
              <span className="font-medium">{selectedModelData.name}</span>
              <span
                className="ml-auto text-xs px-2 py-0.5 rounded-full"
                style={{
                  background: 'var(--color-primary-10)',
                  color: 'var(--color-primary)'
                }}
              >
                {selectedModelData.credits_per_message} 积分
              </span>
            </div>
          )}
        </SelectValue>
      </SelectTrigger>
      <SelectContent
        className={cn(
          "bg-[var(--bg-secondary)]/95 backdrop-blur-xl",
          "border border-[var(--border-primary)]"
        )}
      >
        {models.filter(m => m.is_active).map((model) => {
          const Icon = providerIcons[model.provider] || Sparkles;
          const colors = providerColors[model.provider] || providerColors.custom;

          return (
            <SelectItem
              key={model.id}
              value={model.id}
              data-testid={`chat-model-option-${model.id}`}
              className={cn(
                "cursor-pointer py-3 px-3",
                "hover:bg-[var(--bg-tertiary)]",
                "focus:bg-[var(--bg-tertiary)]",
                "data-[state=checked]:bg-[var(--color-primary-10)]"
              )}
            >
              <div className="flex items-center gap-3 w-full">
                <div className={cn("p-2 rounded-lg", colors.bg)}>
                  <Icon className={cn("h-4 w-4", colors.text)} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-[var(--text-primary)]">
                    {model.name}
                  </div>
                  {model.description && (
                    <div className="text-xs text-[var(--text-tertiary)] mt-0.5 truncate">
                      {model.description}
                    </div>
                  )}
                </div>
                <span
                  className="text-xs px-2 py-0.5 rounded-full border border-[var(--border-secondary)]"
                  style={{ color: 'var(--text-secondary)' }}
                >
                  {model.credits_per_message} 积分
                </span>
              </div>
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}
