import { ChevronRight, Sparkles } from "lucide-solid";
import { createMemo } from "solid-js";
import type { MessageSummary, Tier } from "./shared";

type Insights = Pick<MessageSummary, "aiSummary" | "snippet" | "reasoning" | "tier" | "modelTier">;
const tierNames: Record<Tier, string> = { 1: "Important", 2: "Updates", 3: "Low priority" };
export function MessagePreview(props: { message: Insights }) {
  const summary = createMemo(() => props.message.aiSummary?.trim());
  return (
    <>
      {summary() ? (
        <span class="message-ai-summary" title={summary()}>
          <span class="ai-label">AI</span>
          <span>{summary()}</span>
        </span>
      ) : (
        <span class="message-snippet">{props.message.snippet}</span>
      )}
    </>
  );
}
export function RankingReason(props: {
  message: Insights;
  open?: boolean;
  onToggle?(open: boolean): void;
}) {
  return (
    <>
      {(() => {
        if (!props.message.reasoning?.trim() || props.message.modelTier === null) return null;
        const overridden = createMemo(
          () => props.message.tier !== null && props.message.tier !== props.message.modelTier,
        );
        return (
          <details
            class="ranking-reason"
            open={props.open}
            onToggle={(event) => props.onToggle?.(event.currentTarget.open)}
          >
            <summary>
              <ChevronRight size={12} class="ranking-chevron" aria-hidden="true" />
              <span class="ranking-label">
                {overridden()
                  ? `Your choice: ${tierNames[props.message.tier as Tier]}`
                  : `Why ${tierNames[props.message.modelTier]}`}
              </span>
              <span class="ranking-preview">{props.message.reasoning}</span>
            </summary>
            <div class="ranking-body">
              {overridden() && <strong>AI suggested {tierNames[props.message.modelTier]}</strong>}
              <p>{props.message.reasoning}</p>
            </div>
          </details>
        );
      })()}
    </>
  );
}
export function ReaderInsights(props: { message: Insights }) {
  const summary = createMemo(() => props.message.aiSummary?.trim());
  const hasReasoning = createMemo(
    () => Boolean(props.message.reasoning?.trim()) && props.message.modelTier !== null,
  );
  return (
    <>
      {(() => {
        if (!summary() && !hasReasoning()) return null;
        return (
          <aside class="reader-insights" aria-label="AI insights">
            <div class="insights-heading">
              <Sparkles size={14} aria-hidden="true" /> AI insights
            </div>
            {summary() && <p class="reader-ai-summary">{summary()}</p>}
            <RankingReason message={props.message} open />
          </aside>
        );
      })()}
    </>
  );
}
