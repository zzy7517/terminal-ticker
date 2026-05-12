import { useEffect, useState } from 'react';
import { Clock, Play, Pause, ChevronRight, AlertCircle, CheckCircle2, Loader2 } from 'lucide-react';
import type { CronJobStatus, CronRunRecord, CronSessionEntry } from '../../types';
import {
  fetchCronJobs,
  fetchCronJobRuns,
  fetchCronSession,
  triggerCronJob,
  setCronJobEnabled,
} from '../../api';

type PanelView = 'jobs' | 'history' | 'detail';

export function CronPanel() {
  const [jobs, setJobs] = useState<CronJobStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<PanelView>('jobs');
  const [selectedJob, setSelectedJob] = useState<string | null>(null);
  const [runs, setRuns] = useState<CronRunRecord[]>([]);
  const [sessionEntries, setSessionEntries] = useState<CronSessionEntry[]>([]);
  const [detailJobName, setDetailJobName] = useState('');
  const [triggering, setTriggering] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadJobs();
  }, []);

  async function loadJobs() {
    try {
      setLoading(true);
      const data = await fetchCronJobs();
      setJobs(data);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load cron jobs');
    } finally {
      setLoading(false);
    }
  }

  async function handleToggle(jobName: string, enabled: boolean) {
    try {
      const updated = await setCronJobEnabled(jobName, enabled);
      setJobs(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Toggle failed');
    }
  }

  async function handleTrigger(jobName: string) {
    setTriggering(jobName);
    try {
      await triggerCronJob(jobName);
      await loadJobs();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Trigger failed');
    } finally {
      setTriggering(null);
    }
  }

  async function openHistory(jobName: string) {
    setSelectedJob(jobName);
    setView('history');
    try {
      const data = await fetchCronJobRuns(jobName);
      setRuns(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load runs');
    }
  }

  async function openDetail(run: CronRunRecord) {
    setDetailJobName(run.jobName);
    setView('detail');
    try {
      const data = await fetchCronSession(run.sessionId);
      setSessionEntries(data.entries);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load session');
    }
  }

  function goBack() {
    if (view === 'detail') {
      setView('history');
      setSessionEntries([]);
    } else {
      setView('jobs');
      setSelectedJob(null);
      setRuns([]);
    }
  }

  if (loading) {
    return (
      <div className="cron-panel">
        <div className="cron-empty">
          <Loader2 size={20} className="cron-spinner" />
          <span>Loading cron jobs...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="cron-panel">
      {error && (
        <div className="cron-error-banner">
          <AlertCircle size={14} />
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)}>dismiss</button>
        </div>
      )}

      {view === 'jobs' && <JobsList jobs={jobs} triggering={triggering} onToggle={handleToggle} onTrigger={handleTrigger} onViewHistory={openHistory} />}
      {view === 'history' && <HistoryList jobName={selectedJob!} runs={runs} onBack={goBack} onViewDetail={openDetail} />}
      {view === 'detail' && <SessionDetail jobName={detailJobName} entries={sessionEntries} onBack={goBack} />}
    </div>
  );
}

// ── Jobs List ─────────────────────────────────────────────────────────────

function JobsList(props: {
  jobs: CronJobStatus[];
  triggering: string | null;
  onToggle: (name: string, enabled: boolean) => void;
  onTrigger: (name: string) => void;
  onViewHistory: (name: string) => void;
}) {
  const { jobs, triggering, onToggle, onTrigger, onViewHistory } = props;

  if (jobs.length === 0) {
    return (
      <div className="cron-empty">
        <Clock size={32} strokeWidth={1.2} />
        <p>No cron jobs configured</p>
        <p className="cron-empty-hint">
          Add <code>[[cron_jobs]]</code> entries to your <code>watchlist.toml</code>
        </p>
      </div>
    );
  }

  return (
    <div className="cron-jobs-list">
      <div className="cron-list-header">
        <h3>Scheduled Jobs</h3>
        <span className="cron-count">{jobs.filter((j) => j.enabled).length} active</span>
      </div>
      {jobs.map((job) => (
        <div key={job.name} className={`cron-job-card ${job.enabled ? '' : 'disabled'}`}>
          <div className="cron-job-top">
            <div className="cron-job-identity">
              <div className="cron-job-indicator">
                {job.running ? (
                  <Loader2 size={12} className="cron-spinner" />
                ) : job.enabled ? (
                  <span className="cron-dot active" />
                ) : (
                  <span className="cron-dot" />
                )}
              </div>
              <div>
                <span className="cron-job-name">{job.name}</span>
                <span className="cron-job-expr">{job.cron}</span>
              </div>
            </div>
            <div className="cron-job-actions">
              <button
                type="button"
                className="cron-btn cron-btn-icon"
                title={job.enabled ? 'Pause' : 'Resume'}
                onClick={() => onToggle(job.name, !job.enabled)}
              >
                {job.enabled ? <Pause size={14} /> : <Play size={14} />}
              </button>
              <button
                type="button"
                className="cron-btn cron-btn-trigger"
                title="Run now"
                disabled={triggering === job.name}
                onClick={() => onTrigger(job.name)}
              >
                {triggering === job.name ? <Loader2 size={13} className="cron-spinner" /> : <Play size={13} />}
                <span>Run</span>
              </button>
              <button
                type="button"
                className="cron-btn cron-btn-history"
                onClick={() => onViewHistory(job.name)}
              >
                <span>History</span>
                <ChevronRight size={13} />
              </button>
            </div>
          </div>
          <div className="cron-job-meta">
            {job.nextRun && (
              <span className="cron-meta-item">
                <Clock size={11} />
                Next: {formatRelativeTime(job.nextRun)}
              </span>
            )}
            {job.lastStatus && (
              <span className={`cron-meta-item ${job.lastStatus === 'error' ? 'error' : 'ok'}`}>
                {job.lastStatus === 'ok' ? <CheckCircle2 size={11} /> : <AlertCircle size={11} />}
                Last: {job.lastStatus}{job.lastRunAt ? ` (${formatRelativeTime(job.lastRunAt)})` : ''}
              </span>
            )}
            {job.model && <span className="cron-meta-item cron-meta-model">{job.model}</span>}
          </div>
          {job.systemPrompt && (
            <div className="cron-job-prompt">{job.systemPrompt.slice(0, 120)}{job.systemPrompt.length > 120 ? '...' : ''}</div>
          )}
        </div>
      ))}
    </div>
  );
}

// ── History List ──────────────────────────────────────────────────────────

function HistoryList(props: {
  jobName: string;
  runs: CronRunRecord[];
  onBack: () => void;
  onViewDetail: (run: CronRunRecord) => void;
}) {
  const { jobName, runs, onBack, onViewDetail } = props;

  return (
    <div className="cron-history">
      <div className="cron-history-header">
        <button type="button" className="cron-btn cron-btn-back" onClick={onBack}>
          &larr; Back
        </button>
        <h3>{jobName}</h3>
        <span className="cron-count">{runs.length} runs</span>
      </div>
      {runs.length === 0 ? (
        <div className="cron-empty">
          <p>No runs yet</p>
        </div>
      ) : (
        <div className="cron-runs-list">
          {runs.map((run) => (
            <button
              key={run.sessionId}
              type="button"
              className="cron-run-row"
              onClick={() => onViewDetail(run)}
            >
              <div className="cron-run-status">
                {run.status === 'ok' ? (
                  <CheckCircle2 size={14} className="cron-status-ok" />
                ) : run.status === 'error' ? (
                  <AlertCircle size={14} className="cron-status-error" />
                ) : (
                  <Loader2 size={14} className="cron-spinner" />
                )}
              </div>
              <div className="cron-run-info">
                <span className="cron-run-time">{formatTime(run.startedAt)}</span>
                <span className="cron-run-preview">{run.preview || '(no output)'}</span>
              </div>
              <ChevronRight size={14} className="cron-run-chevron" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Session Detail ────────────────────────────────────────────────────────

function SessionDetail(props: {
  jobName: string;
  entries: CronSessionEntry[];
  onBack: () => void;
}) {
  const { jobName, entries, onBack } = props;

  const messages = entries.filter(
    (e) => e.type === 'message' && (e.role === 'user' || e.role === 'assistant'),
  );

  return (
    <div className="cron-detail">
      <div className="cron-history-header">
        <button type="button" className="cron-btn cron-btn-back" onClick={onBack}>
          &larr; Back
        </button>
        <h3>{jobName}</h3>
      </div>
      <div className="cron-messages">
        {messages.map((msg, i) => (
          <div key={i} className={`cron-message ${msg.role}`}>
            <div className="cron-message-role">{msg.role}</div>
            <div className="cron-message-content">
              {msg.content || '(empty)'}
            </div>
            {msg.error && <div className="cron-message-error">{msg.error}</div>}
          </div>
        ))}
        {messages.length === 0 && (
          <div className="cron-empty"><p>No messages in this session</p></div>
        )}
      </div>
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────

function formatRelativeTime(isoString: string): string {
  const date = new Date(isoString);
  const now = Date.now();
  const diff = date.getTime() - now;
  const absDiff = Math.abs(diff);

  if (absDiff < 60_000) return diff > 0 ? 'in <1m' : '<1m ago';
  if (absDiff < 3_600_000) {
    const mins = Math.round(absDiff / 60_000);
    return diff > 0 ? `in ${mins}m` : `${mins}m ago`;
  }
  if (absDiff < 86_400_000) {
    const hrs = Math.round(absDiff / 3_600_000);
    return diff > 0 ? `in ${hrs}h` : `${hrs}h ago`;
  }
  const days = Math.round(absDiff / 86_400_000);
  return diff > 0 ? `in ${days}d` : `${days}d ago`;
}

function formatTime(isoString: string): string {
  const date = new Date(isoString);
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
