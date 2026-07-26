/** One tool call in an Origin timeline: a single headline row that opens into detail. */
import { useState } from 'react';
import {
  AlertCircle,
  Bot,
  Check,
  ChevronRight,
  FileText,
  FolderOpen,
  Globe,
  Loader2,
  Minus,
  Pencil,
  Search,
  Terminal,
  Wrench,
} from 'lucide-react';
import { buildOriginToolView, type OriginToolIcon, type OriginToolViewInput } from '../../chat/originToolDisplay';

const TOOL_ICONS: Record<OriginToolIcon, typeof Wrench> = {
  shell: Terminal,
  read: FileText,
  edit: Pencil,
  search: Search,
  list: FolderOpen,
  fetch: Globe,
  task: Bot,
  tool: Wrench,
};

export function OriginToolCallRow({ call }: { call: OriginToolViewInput }) {
  const [open, setOpen] = useState(false);
  const view = buildOriginToolView(call);
  const Icon = TOOL_ICONS[view.icon];
  const expandable = Boolean(view.input || view.output);

  return (
    <div className={`origin-tool-row origin-tool-row--${view.status}${open ? ' open' : ''}`}>
      <button
        aria-expanded={expandable ? open : undefined}
        className="origin-tool-head"
        disabled={!expandable}
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <span className="origin-tool-status" aria-hidden="true">
          {view.status === 'running' ? <Loader2 className="spin" size={12} />
            : view.status === 'error' ? <AlertCircle size={12} />
              : view.status === 'pending' ? <Minus size={12} />
                : <Check size={12} />}
        </span>
        <Icon className="origin-tool-icon" size={13} aria-hidden="true" />
        <span className="origin-tool-label">{view.label}</span>
        {view.summary ? <span className="origin-tool-summary">{view.summary}</span> : null}
        {view.detail ? <span className="origin-tool-detail">{view.detail}</span> : null}
        {expandable ? (
          <ChevronRight className={`origin-tool-chevron${open ? ' open' : ''}`} size={13} aria-hidden="true" />
        ) : null}
      </button>
      {open && expandable ? (
        <div className="origin-tool-body">
          {view.input ? (
            <section className="origin-tool-section">
              <small>Input</small>
              <pre>{view.input}</pre>
            </section>
          ) : null}
          {view.output ? (
            <section className={`origin-tool-section${view.status === 'error' ? ' error' : ''}`}>
              <small>Output</small>
              <pre>{view.output}</pre>
              {view.truncated ? <p className="origin-tool-truncated">Output truncated</p> : null}
            </section>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
