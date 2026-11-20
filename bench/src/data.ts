export const SEARCH_TERMS = { rare: "zanzibar", common: "invoice" } as const;
export const THREAD_SIZES = [
  [1, 19955],
  [2, 624],
  [3, 211],
  [4, 81],
  [5, 36],
  [6, 24],
  [7, 16],
  [8, 16],
  [9, 6],
  [10, 4],
  [11, 3],
  [12, 3],
  [14, 1],
  [16, 1],
  [18, 1],
  [20, 1],
  [21, 1],
  [26, 1],
  [30, 1],
] as const;
export const MESSAGE_COUNT = 23032;
export const INBOX_THREAD_SIZES = [
  [1, 868],
  [2, 13],
  [3, 32],
  [4, 11],
  [5, 1],
  [6, 1],
  [8, 2],
] as const;
const NEWEST_INBOX_SIZES = [
  [1, 56],
  [2, 7],
  [3, 6],
  [4, 3],
  [5, 1],
  [6, 1],
  [8, 1],
] as const;
// Fixed clock keeps dates and all generated values reproducible across runs.
export const AS_OF = Date.parse("2026-11-20T00:00:00Z");
const START = Date.parse("2017-01-01T00:00:00Z");
const names = ["Maya Chen", "Oliver Reed", "Amara Patel", "Leo Brooks", "Sofia Garcia", "Noah Kim"];
const teams = [
  "Harbor Studio",
  "Cedar Collective",
  "Summit Labs",
  "Orchard Review",
  "Maple Travel",
  "River Works",
];
const topics = [
  "Project planning",
  "Weekly newsletter",
  "Travel itinerary",
  "Design review",
  "Community update",
  "Delivery schedule",
  "Quarterly report",
  "Team workshop",
];
const sentences = [
  "Thank you for sharing your thoughts with our team. We have prepared the next steps for your review.",
  "This week we are exploring new ideas from the community and highlighting practical resources for the months ahead.",
  "Please review the attached notes and let us know which option works best for your schedule.",
  "Our latest collection brings together thoughtful recommendations, useful updates, and stories from our partners.",
  "We look forward to hearing your feedback and continuing the conversation at our next meeting.",
];

export function validateDatabaseUrl(value: string | undefined): string {
  if (!value) throw new Error("DATABASE_URL is required");
  const url = new URL(value);
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !decodeURIComponent(url.pathname.slice(1)).startsWith("sent_bench")
  ) {
    throw new Error("Refusing to seed: database name must start with sent_bench");
  }
  return value;
}

export function parseSeed(args: string[]): number {
  if (args.length === 0) return 1;
  if (args.length !== 2 || args[0] !== "--seed" || !/^\d+$/.test(args[1] ?? ""))
    throw new Error("Usage: pnpm bench:seed [--seed <uint32>]");
  const seed = Number(args[1]);
  if (!Number.isSafeInteger(seed) || seed > 0xffffffff) throw new Error("Seed must be a uint32");
  return seed;
}

export function randomGenerator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let t = Math.imul(state ^ (state >>> 15), state | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function id(kind: number, index: number): string {
  return `${kind.toString(16).padStart(8, "0")}-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function threadLayout(seed: number) {
  const random = randomGenerator(seed ^ 0x51ab037);
  const shuffle = <T>(values: T[]): T[] => {
    for (let i = values.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [values[i], values[j]] = [values[j] as T, values[i] as T];
    }
    return values;
  };
  const inboxCounts = new Map<number, number>(INBOX_THREAD_SIZES);
  const newestCounts = new Map<number, number>(NEWEST_INBOX_SIZES);
  const threads = THREAD_SIZES.flatMap(([size, count]) =>
    Array.from({ length: count }, () => ({ size, inbox: false, latest: 0 })),
  );
  const inbox: typeof threads = [];
  const newest: typeof threads = [];
  for (const [size] of THREAD_SIZES) {
    const candidates = shuffle(threads.filter((thread) => thread.size === size));
    for (const [index, thread] of candidates.entries()) {
      if (index < (inboxCounts.get(size) ?? 0)) {
        thread.inbox = true;
        (index < (newestCounts.get(size) ?? 0) ? newest : inbox).push(thread);
      } else {
        thread.latest = START + random() * (AS_OF - 100 * 86400000 - START);
      }
    }
  }
  const ordered = [...shuffle(inbox), ...shuffle(newest)];
  for (const [index, thread] of ordered.entries())
    thread.latest = AS_OF - (ordered.length - 1 - index) * 7200000;
  return threads;
}

export function* generateMessages(seed: number) {
  const random = randomGenerator(seed);
  const pick = <T>(values: readonly T[]): T => values[Math.floor(random() * values.length)] as T;
  let index = 0;
  let threadIndex = 0;
  let gmailRemaining = 17036;
  const layout = threadLayout(seed);
  let inboxClassification = 0;
  let otherClassification = 1061;
  let outboundCount = 0;
  for (const [size, count] of THREAD_SIZES) {
    for (let t = 0; t < count; t++) {
      const account = gmailRemaining >= size ? 1 : 2;
      if (account === 1) gmailRemaining -= size;
      const threadId = id(2, ++threadIndex);
      const placement = layout[threadIndex - 1];
      if (!placement) throw new Error("Missing thread placement");
      const topic = `${pick(topics)} — ${pick(teams)} #${threadIndex}`;
      for (let n = 0; n < size; n++) {
        const i = index++;
        const term = i < 25 ? SEARCH_TERMS.rare : i < 2025 ? SEARCH_TERMS.common : "";
        const subject = `${n ? "Re: " : ""}${topic}${term ? ` · ${term}` : ""}`;
        const name = pick(names);
        const intro = `Hello,\n\n${subject}\n\nAn update from ${name} at ${pick(teams)}.\n\n`;
        const target = 3500 + Math.floor(random() * 4800);
        let text = intro;
        while (text.length < target) text += `${pick(sentences)}\n\n`;
        text = text.slice(0, target);
        const normal =
          Math.sqrt(-2 * Math.log(Math.max(random(), 1e-10))) * Math.cos(2 * Math.PI * random());
        const htmlLength = Math.min(
          177000,
          Math.max(1500, Math.round(17000 * Math.exp(1.1 * normal))),
        );
        let html = `<html><body style="background:#f5f5f5;font-family:Arial"><table width="600" style="margin:auto;background:white"><tr><td><h1>${subject}</h1><p>${intro}</p></td></tr>`;
        while (html.length < htmlLength)
          html += `<tr><td style="padding:16px 24px;border-bottom:1px solid #eee;color:#333;font-size:15px;line-height:1.6"><h2>${pick(topics)}</h2><p>${pick(sentences)}</p><p>${pick(sentences)}</p></td></tr>`;
        html = `${html.slice(0, htmlLength - 28)}</table></body></html>`;
        const outbound = !placement.inbox && outboundCount < 755;
        const outboundIndex = outbound ? outboundCount++ : -1;
        const classificationIndex = placement.inbox ? inboxClassification++ : otherClassification++;
        const tierRank = (classificationIndex * 3571) % 9239;
        const receivedAt = new Date(placement.latest - (size - 1 - n) * 3600000).toISOString();
        yield {
          id: id(3, i + 1),
          account_id: id(1, account),
          thread_id: threadId,
          provider_message_id: `bench-message-${i + 1}`,
          provider_thread_id: `bench-thread-${threadIndex}`,
          subject,
          from_addresses: [
            { name, address: `${name.toLowerCase().replaceAll(" ", ".")}@example.test` },
          ],
          to_addresses: [
            {
              name: "Alex Morgan",
              address: account === 1 ? "alex@gmail.example.test" : "alex@microsoft.example.test",
            },
          ],
          received_at: receivedAt,
          snippet: text.slice(0, 200),
          text_body: text,
          html_body: i % 1000 < 966 ? html : null,
          headers: { "message-id": `<bench-${i + 1}@example.test>`, "x-benchmark": "synthetic" },
          attachments:
            i < 1288
              ? [
                  {
                    id: `attachment-${i}`,
                    filename: `report-${i + 1}.pdf`,
                    mimeType: "application/pdf",
                    size: 24576 + i,
                  },
                ]
              : [],
          direction: outbound ? "outbound" : "inbound",
          read: (i * 37) % 100 >= 48,
          archived: !placement.inbox && !(outboundIndex >= 0 && outboundIndex < 695),
          tier: classificationIndex >= 9239 ? null : tierRank < 1228 ? 1 : tierRank < 8036 ? 2 : 3,
        };
      }
    }
  }
}
