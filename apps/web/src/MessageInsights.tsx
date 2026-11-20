import type { MessageSummary, Tier } from "@sent/shared";
import { ChevronRight, Sparkles } from "lucide-react";

type Insights = Pick<MessageSummary, "aiSummary" | "snippet" | "reasoning" | "tier" | "modelTier">;

const tierNames: Record<Tier, string> = { 1: "Important", 2: "Updates", 3: "Low priority" };

export function MessagePreview({ message }: { message: Insights }) {
  const summary = message.aiSummary?.trim();
  return summary ? (
    <span className="message-ai-summary" title={summary}>
      <span className="ai-label">AI</span>
      <span>{summary}</span>
    </span>
  ) : (
    <span className="message-snippet">{message.snippet}</span>
  );
}

export function RankingReason({ message, open }: { message: Insights; open?: boolean }) {
  if (!message.reasoning?.trim() || message.modelTier === null) return null;
  const overridden = message.tier !== null && message.tier !== message.modelTier;
  return (
    <details className="ranking-reason" open={open}>
      <summary>
        <ChevronRight size={12} className="ranking-chevron" aria-hidden="true" />
        <span className="ranking-label">
          {overridden
            ? `Your choice: ${tierNames[message.tier as Tier]}`
            : `Why ${tierNames[message.modelTier]}`}
        </span>
        <span className="ranking-preview">{message.reasoning}</span>
      </summary>
      <div className="ranking-body">
        {overridden && <strong>AI suggested {tierNames[message.modelTier]}</strong>}
        <p>{message.reasoning}</p>
      </div>
    </details>
  );
}

export function ReaderInsights({ message }: { message: Insights }) {
  const summary = message.aiSummary?.trim();
  const hasReasoning = Boolean(message.reasoning?.trim()) && message.modelTier !== null;
  if (!summary && !hasReasoning) return null;
  return (
    <aside className="reader-insights" aria-label="AI insights">
      <div className="insights-heading">
        <Sparkles size={14} aria-hidden="true" /> AI insights
      </div>
      {summary && <p className="reader-ai-summary">{summary}</p>}
      <RankingReason message={message} open />
    </aside>
  );
}
