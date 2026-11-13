'use client';

import { memo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Plus, ArrowLeft, Loader2, Upload, X } from 'lucide-react';
import { trpc } from '@/trpc/client';
import { logClientDevError } from '@/lib/client-log';
import { useTicketAttachments } from '@/hooks/use-ticket-attachments';
import { categoryOptions, type MockUser } from './ticketsShared';
// Phones only (639px and below): the app-style layout of the ticket pages; a computer is unchanged.
import phone from './tickets-phone.module.css';

// 创建工单表单
export const CreateTicketForm = memo(function CreateTicketForm({
  onBack,
  onSuccess
}: {
  user: MockUser;
  onBack: () => void;
  onSuccess: () => void | Promise<void>;
}) {
  const [formData, setFormData] = useState({
    title: '',
    description: '',
    category: 'technical_support'
  });
  const { attachments, uploading, uploadError, handleFileUpload, removeAttachment } = useTicketAttachments();

  // tRPC mutation for creating ticket
  const createMutation = trpc.ticket.createTicket.useMutation({
    onSuccess: async () => {
      await onSuccess();
    },
    onError: () => {
      logClientDevError('Failed to create ticket');
    },
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.title.trim() || !formData.description.trim()) {
      return;
    }
    createMutation.mutate({
      title: formData.title.trim(),
      description: formData.description.trim(),
      category: formData.category,
      attachments: attachments.map(a => a.path),
    });
  };

  return (
    <div
      className={`rounded-2xl p-6 ${phone.card}`}
      style={{
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border-primary)',
        boxShadow: '0 4px 20px rgba(0,0,0,0.2)'
      }}
    >
      <Button
        variant="ghost"
        onClick={onBack}
        className={`mb-4 -ml-2 ${phone.back}`}
        style={{ color: 'var(--text-secondary)' }}
      >
        <ArrowLeft className="h-4 w-4 mr-2" />
        返回工单列表
      </Button>

      <h3 className={`text-lg font-bold mb-6 ${phone.title}`} style={{ color: 'var(--text-primary)' }}>创建新工单</h3>

      <form onSubmit={handleSubmit} className={`space-y-6 ${phone.form}`}>
        <div>
          <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-primary)' }}>
            标题 <span style={{ color: 'var(--error)' }}>*</span>
          </label>
          <Input
            value={formData.title}
            onChange={(e) => setFormData({ ...formData, title: e.target.value })}
            placeholder="简要描述您的问题"
            style={{
              background: 'var(--bg-primary)',
              borderColor: 'var(--border-primary)',
              color: 'var(--text-primary)'
            }}
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-primary)' }}>
            分类
          </label>
          <Select value={formData.category} onValueChange={(v) => setFormData({ ...formData, category: v })}>
            <SelectTrigger style={{ background: 'var(--bg-primary)', borderColor: 'var(--border-primary)', color: 'var(--text-primary)' }}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {categoryOptions.map(opt => (
                <SelectItem key={opt.value} value={opt.value} className={phone.option}>{opt.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div>
          <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-primary)' }}>
            问题描述 <span style={{ color: 'var(--error)' }}>*</span>
          </label>
          <Textarea
            value={formData.description}
            onChange={(e) => setFormData({ ...formData, description: e.target.value })}
            placeholder="请详细描述您遇到的问题..."
            className="min-h-[150px]"
            style={{
              background: 'var(--bg-primary)',
              borderColor: 'var(--border-primary)',
              color: 'var(--text-primary)'
            }}
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-primary)' }}>
            附件截图
          </label>
          <div
            className="p-4 rounded-xl border-2 border-dashed transition-colors"
            style={{ borderColor: 'var(--border-primary)', background: 'var(--bg-primary)' }}
          >
            <input
              type="file"
              accept="image/*"
              multiple
              onChange={handleFileUpload}
              className="hidden"
              id="ticket-attachment"
              disabled={uploading}
            />
            <label
              htmlFor="ticket-attachment"
              className="flex flex-col items-center justify-center cursor-pointer py-4"
            >
              {uploading ? (
                <Loader2 className="h-8 w-8 animate-spin mb-2" style={{ color: 'var(--color-primary)' }} />
              ) : (
                <Upload className="h-8 w-8 mb-2" style={{ color: 'var(--text-tertiary)' }} />
              )}
              <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                {uploading ? '上传中...' : '点击上传截图（支持多张）'}
              </span>
              <span className="text-xs mt-1" style={{ color: 'var(--text-disabled)' }}>
                支持 JPG、PNG 格式，单张不超过 5MB
              </span>
            </label>
          </div>
          {uploadError && <p className="mt-2 text-sm" style={{ color: 'var(--error)' }}>{uploadError}</p>}

          {attachments.length > 0 && (
            <div className="mt-3 space-y-2">
              {attachments.map((att, index) => (
                <div
                  key={index}
                  className="flex items-center justify-between p-3 rounded-lg"
                  style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-primary)' }}
                >
                  <div className="flex items-center gap-3">
                    <img src={att.previewUrl} alt={att.name} loading="lazy" className="w-12 h-12 object-cover rounded" />
                    <span className="text-sm truncate max-w-[200px]" style={{ color: 'var(--text-primary)' }}>
                      {att.name}
                    </span>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className={phone.remove}
                    aria-label={`移除 ${att.name}`}
                    onClick={() => removeAttachment(index)}
                    style={{ color: 'var(--text-tertiary)' }}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className={`flex justify-end gap-3 ${phone.actions}`}>
          <Button
            type="button"
            variant="outline"
            onClick={onBack}
            style={{
              background: 'transparent',
              borderColor: 'var(--border-primary)',
              color: 'var(--text-secondary)'
            }}
          >
            取消
          </Button>
          <Button
            type="submit"
            disabled={createMutation.isPending}
            className="gap-2"
            style={{
              background: 'linear-gradient(135deg, var(--color-primary) 0%, var(--color-secondary) 100%)',
              color: 'var(--bg-primary)'
            }}
          >
            {createMutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Plus className="h-4 w-4" />
            )}
            提交工单
          </Button>
        </div>
      </form>
    </div>
  );
});
