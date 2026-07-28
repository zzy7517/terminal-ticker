/** Shared tool-call row — presentational only; live activity is assembled by the timeline. */
import { useState, type ReactNode } from 'react';
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
import {
  buildOriginToolView,
  type OriginToolIcon,
  type OriginToolViewInput,
} from '../../chat/originToolDisplay';
import './ToolCallRow.css';

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

export function ToolCallGroup({ children }: { children: ReactNode }) {
  return <div className="session-tool-group">{children}</div>;
}

export function ToolCallRow({ call }: { call: OriginToolViewInput }) {
  const [open, setOpen] = useState(false);
  const view = buildOriginToolView(call);
  const Icon = TOOL_ICONS[view.icon];
  const expandable = Boolean(view.input || view.output);

  return (
    <div className={`session-tool-row session-tool-row--${view.status}${open ? ' open' : ''}`}>
      <button
        aria-expanded={expandable ? open : undefined}
        className="session-tool-head"
        disabled={!expandable}
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <span className="session-tool-status" aria-hidden="true">
          {view.status === 'running' ? <Loader2 className="spin" size={12} />
            : view.status === 'error' ? <AlertCircle size={12} />
              : view.status === 'pending' ? <Minus size={12} />
                : <Check size={12} />}
        </span>
        <Icon className="session-tool-icon" size={13} aria-hidden="true" />
        <span className="session-tool-label">{view.label}</span>
        {view.summary ? <span className="session-tool-summary">{view.summary}</span> : null}
        {view.detail ? <span className="session-tool-detail">{view.detail}</span> : null}
        {expandable ? (
          <ChevronRight className={`session-tool-chevron${open ? ' open' : ''}`} size={13} aria-hidden="true" />
        ) : null}
      </button>
      {open && expandable ? (
        <div className="session-tool-body">
          {view.input ? (
            <section className="session-tool-section">
              <small>Input</small>
              <pre>{view.input}</pre>
            </section>
          ) : null}
          {view.output ? (
            <section className={`session-tool-section${view.status === 'error' ? ' error' : ''}`}>
              <small>Output</small>
              <pre>{view.output}</pre>
              {view.truncated ? <p className="session-tool-truncated">Output truncated</p> : null}
            </section>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
