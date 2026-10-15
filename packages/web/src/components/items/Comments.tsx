import { useEffect, useRef, useState } from 'react';
import { Reply, Pencil, Trash2 } from 'lucide-react';
import type { Comment } from '@pm/core';
import { useComments, useStore } from '../../store/hooks';
import { useSession } from '../../session';
import { useActions } from './useActions';
import { Markdown } from './Markdown';
import { Avatar, Button } from '../ui';
import { relTime, cn } from '../../lib/util';

/** Markdown textarea with @mention autocomplete inserting `@[Name](user:<uuid>)`. */
export function MentionTextarea({ value, onChange, onSubmit, placeholder, autoFocus, className, rows = 3 }: { value: string; onChange: (v: string) => void; onSubmit?: () => void; placeholder?: string; autoFocus?: boolean; className?: string; rows?: number }) {
  const { users } = useStore();
  const ref = useRef<HTMLTextAreaElement>(null);
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [cursor, setCursor] = useState(0);

  const candidates = mention ? users.filter((u) => u.is_active && u.name.toLowerCase().includes(mention.query.toLowerCase())).slice(0, 6) : [];

  const detect = (text: string, caret: number) => {
    const before = text.slice(0, caret);
    const m = /(^|\s)@([\w.-]*)$/.exec(before);
    if (m) setMention({ start: caret - m[2]!.length - 1, query: m[2]! });
    else setMention(null);
    setCursor(0);
  };

  const insert = (u: { id: string; name: string }) => {
    if (!mention) return;
    const el = ref.current;
    const caret = el?.selectionStart ?? value.length;
    const token = `@[${u.name}](user:${u.id}) `;
    const next = value.slice(0, mention.start) + token + value.slice(caret);
    onChange(next);
    setMention(null);
    requestAnimationFrame(() => {
      if (el) {
        el.focus();
        const pos = mention.start + token.length;
        el.setSelectionRange(pos, pos);
      }
    });
  };

  return (
    <div className="relative">
      <textarea
        ref={ref}
        value={value}
        autoFocus={autoFocus}
        rows={rows}
        placeholder={placeholder}
        className={cn('w-full resize-y rounded-md border border-border bg-bg px-2.5 py-1.5 text-sm leading-relaxed outline-none placeholder:text-fg-faint focus:border-accent', className)}
        onChange={(e) => {
          onChange(e.target.value);
          detect(e.target.value, e.target.selectionStart);
        }}
        onKeyDown={(e) => {
          if (mention && candidates.length) {
            if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => (c + 1) % candidates.length); return; }
            if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => (c - 1 + candidates.length) % candidates.length); return; }
            if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); insert(candidates[cursor]!); return; }
            if (e.key === 'Escape') { e.stopPropagation(); setMention(null); return; }
          }
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); onSubmit?.(); }
        }}
        onClick={(e) => detect(value, (e.target as HTMLTextAreaElement).selectionStart)}
      />
      {mention && candidates.length > 0 && (
        <div className="absolute left-2 z-50 mt-1 w-64 rounded-md border border-border bg-bg-elevated p-1 shadow-[var(--shadow)]">
          {candidates.map((u, i) => (
            <button key={u.id} type="button" className={cn('flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm', i === cursor && 'bg-bg-muted')} onMouseDown={(e) => { e.preventDefault(); insert(u); }} onMouseEnter={() => setCursor(i)}>
              <Avatar user={u} size={16} /> {u.name} <span className="ml-auto text-xs text-fg-faint">{u.email}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function CommentNode({ c, replies, onReply }: { c: Comment; replies: Comment[]; onReply: (id: string) => void }) {
  const { usersById } = useStore();
  const { me } = useSession();
  const a = useActions();
  const author = c.author_id ? usersById[c.author_id] : undefined;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(c.body);
  const mine = c.author_id === me?.user.id;
  return (
    <div className="group">
      <div className="flex items-start gap-2.5">
        <Avatar user={author} size={24} className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2 text-xs">
            <span className="font-medium text-fg">{author?.name ?? (c.source !== 'web' ? c.source : 'Unknown')}</span>
            <span className="text-fg-faint" title={c.created_at}>{relTime(c.created_at)}</span>
            {c.edited_at && <span className="text-fg-faint">(edited)</span>}
            {c.source && c.source !== 'web' && <span className="rounded bg-bg-muted px-1 text-[10px] text-fg-muted">{c.source}</span>}
            <span className="ml-auto flex gap-1 opacity-0 group-hover:opacity-100">
              <button className="text-fg-faint hover:text-fg" title="Reply" onClick={() => onReply(c.id)}><Reply size={13} /></button>
              {mine && <button className="text-fg-faint hover:text-fg" title="Edit" onClick={() => setEditing(true)}><Pencil size={12} /></button>}
              {mine && <button className="text-fg-faint hover:text-danger" title="Delete" onClick={() => void a.deleteComment(c.id)}><Trash2 size={12} /></button>}
            </span>
          </div>
          {editing ? (
            <div className="mt-1">
              <MentionTextarea value={draft} onChange={setDraft} autoFocus onSubmit={() => { void a.editComment(c.id, draft); setEditing(false); }} />
              <div className="mt-1 flex gap-2">
                <Button size="xs" variant="primary" onClick={() => { void a.editComment(c.id, draft); setEditing(false); }}>Save</Button>
                <Button size="xs" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
              </div>
            </div>
          ) : (
            <Markdown text={c.body} className="mt-0.5" />
          )}
        </div>
      </div>
      {replies.length > 0 && (
        <div className="mt-2 ml-5 space-y-3 border-l border-border pl-4">
          {replies.map((r) => (
            <CommentNode key={r.id} c={r} replies={[]} onReply={() => onReply(c.id)} />
          ))}
        </div>
      )}
    </div>
  );
}

export function CommentsSection({ itemId }: { itemId: string }) {
  const comments = useComments(itemId);
  const a = useActions();
  const [draft, setDraft] = useState('');
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const { usersById } = useStore();
  const roots = comments.filter((c) => !c.parent_id);
  const repliesOf = (id: string) => comments.filter((c) => c.parent_id === id);
  const replyTarget = replyTo ? comments.find((c) => c.id === replyTo) : undefined;
  const submit = async () => {
    const body = draft.trim();
    if (!body) return;
    await a.addComment(itemId, body, replyTo);
    setDraft('');
    setReplyTo(null);
  };
  useEffect(() => setReplyTo(null), [itemId]);
  return (
    <section>
      <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-fg-faint">Comments {comments.length ? `(${comments.length})` : ''}</h3>
      <div className="space-y-4">
        {roots.map((c) => (
          <CommentNode key={c.id} c={c} replies={repliesOf(c.id)} onReply={setReplyTo} />
        ))}
        {roots.length === 0 && <div className="text-sm text-fg-faint">No comments yet.</div>}
      </div>
      <div className="mt-4">
        {replyTarget && (
          <div className="mb-1 flex items-center gap-2 text-xs text-fg-muted">
            Replying to {replyTarget.author_id ? usersById[replyTarget.author_id]?.name : 'comment'} <button className="text-accent" onClick={() => setReplyTo(null)}>cancel</button>
          </div>
        )}
        <MentionTextarea value={draft} onChange={setDraft} onSubmit={() => void submit()} placeholder="Write a comment… @ to mention, ⌘↵ to send" />
        <div className="mt-1.5 flex justify-end">
          <Button variant="primary" onClick={() => void submit()} disabled={!draft.trim()}>Comment</Button>
        </div>
      </div>
    </section>
  );
}
