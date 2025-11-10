"use client";

import { ChangeEvent, FormEvent, useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type Task = {
  id: string;
  title: string;
  urgent: boolean;
  important: boolean;
  completed: boolean;
  rationale: string;
  createdAt: string;
};

type KcsChunk = {
  id: string;
  content: string;
  metadata: {
    chunkIndex: number;
    createdAt: string;
    source: string;
    tokenEstimate: number;
    hash: string;
  };
};

const TASKS_STORAGE_KEY = "agentic-eisenhower-tasks";
const IR_STORAGE_KEY = "agentic-ai-ir";
const IR_MD_STORAGE_KEY = "agentic-ai-ir-md";
const KCS_STORAGE_KEY = "agentic-ai-kcs";
const KCS_CHUNKS_KEY = "agentic-ai-kcs-chunks";

const urgentLabels = {
  true: "Urgent",
  false: "Not Urgent",
} as const;

const importantLabels = {
  true: "Important",
  false: "Not Important",
} as const;

const quadrantTitles: Record<string, string> = {
  "true-true": "Do First",
  "true-false": "Delegate",
  "false-true": "Schedule",
  "false-false": "Eliminate",
};

const createId = () =>
  typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);

const estimateTokens = (text: string) => {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words * 1.25));
};

const simpleHash = (text: string) => {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash << 5) - hash + text.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
};

function classifyTask(text: string): Pick<Task, "urgent" | "important" | "rationale"> {
  const content = text.toLowerCase();
  const urgentKeywords = [
    "urgent",
    "asap",
    "today",
    "now",
    "immediately",
    "deadline",
    "due",
    "tonight",
    "priority",
    "this hour",
    "first thing",
    "hurry",
    "escalated",
  ];
  const importantKeywords = [
    "important",
    "critical",
    "vital",
    "strategic",
    "key",
    "goal",
    "milestone",
    "essential",
    "impact",
    "launch",
    "client",
    "review",
    "planning",
  ];
  const delegateKeywords = ["delegate", "handoff", "assign", "assist", "support"];
  const eliminateKeywords = ["later", "someday", "optional", "nice to", "maybe", "whenever"];

  const matchedUrgent = urgentKeywords.filter((keyword) => content.includes(keyword));
  const matchedImportant = importantKeywords.filter((keyword) => content.includes(keyword));
  const matchedDelegate = delegateKeywords.filter((keyword) => content.includes(keyword));
  const matchedEliminate = eliminateKeywords.filter((keyword) => content.includes(keyword));

  const soonMatch = content.match(/\b(in|within)\s+\d+\s*(minutes?|hours?|days?)\b/);
  const dateMatch = content.match(/\b(mon|tue|wed|thu|fri|sat|sun|tomorrow|tonight|today)\b/);

  let urgent = matchedUrgent.length > 0 || Boolean(soonMatch) || Boolean(dateMatch);
  let important = matchedImportant.length > 0;

  if (!important && /\b(report|presentation|research|analysis|strategy|roadmap)\b/.test(content)) {
    important = true;
  }

  if (matchedDelegate.length > 0) {
    important = false;
  }

  if (matchedEliminate.length > 0) {
    urgent = false;
    important = false;
  }

  const rationaleParts: string[] = [];

  if (matchedUrgent.length > 0) {
    rationaleParts.push(`Flagged urgent via ${matchedUrgent.join(", ")}`);
  } else if (soonMatch) {
    rationaleParts.push(`Time-bound phrase "${soonMatch[0]}"`);
  } else if (dateMatch) {
    rationaleParts.push(`Near-term schedule reference "${dateMatch[0]}"`);
  }

  if (matchedImportant.length > 0) {
    rationaleParts.push(`High-impact cues: ${matchedImportant.join(", ")}`);
  }

  if (matchedDelegate.length > 0) {
    rationaleParts.push(`Delegation hint: ${matchedDelegate.join(", ")}`);
  }

  if (matchedEliminate.length > 0) {
    rationaleParts.push(`Low-priority phrasing: ${matchedEliminate.join(", ")}`);
  }

  if (!rationaleParts.length) {
    rationaleParts.push("Default review classification");
  }

  return { urgent, important, rationale: rationaleParts.join(" · ") };
}

function convertIrToMarkdown(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";

  const sections = trimmed.split(/\n{2,}/).map((section) => section.trim()).filter(Boolean);

  return sections
    .map((section, index) => {
      if (!section) return "";
      if (index === 0 && !section.startsWith("#")) {
        return `# ${section}`;
      }

      const lines = section.split(/\n/).map((line) => line.trim()).filter((line) => line.length > 0);
      if (!lines.length) return "";

      if (lines.length === 1) {
        const line = lines[0];
        if (/^[-*]\s/.test(line) || /^\d+\.\s/.test(line)) {
          return line;
        }
        if (line.includes(":")) {
          const [label, ...rest] = line.split(":");
          return `**${label.trim()}**: ${rest.join(":").trim()}`;
        }
        return line;
      }

      return lines
        .map((line) => {
          if (/^[-*]\s/.test(line) || /^\d+\.\s/.test(line)) {
            return line;
          }
          return `- ${line.replace(/^[-*]\s*/, "")}`;
        })
        .join("\n");
    })
    .join("\n\n");
}

function chunkKnowledgeBase(text: string, chunkSize = 650, overlap = 80): KcsChunk[] {
  const normalized = text.replace(/\r/g, "").trim();
  if (!normalized) return [];

  const paragraphs = normalized.split(/\n{2,}/).map((paragraph) => paragraph.trim()).filter(Boolean);
  const rawChunks: string[] = [];
  let buffer = "";

  paragraphs.forEach((paragraph) => {
    const candidate = buffer ? `${buffer}\n\n${paragraph}` : paragraph;
    if (candidate.length <= chunkSize) {
      buffer = candidate;
      return;
    }

    if (buffer) {
      rawChunks.push(buffer);
    }

    if (paragraph.length <= chunkSize) {
      buffer = paragraph;
    } else {
      for (let i = 0; i < paragraph.length; i += chunkSize - overlap) {
        rawChunks.push(paragraph.slice(i, i + chunkSize));
      }
      buffer = "";
    }
  });

  if (buffer) {
    rawChunks.push(buffer);
  }

  if (!rawChunks.length) {
    rawChunks.push(normalized);
  }

  const timestamp = new Date().toISOString();

  return rawChunks.map((chunk, index) => ({
    id: createId(),
    content: chunk,
    metadata: {
      chunkIndex: index,
      createdAt: timestamp,
      source: "manual-entry",
      tokenEstimate: estimateTokens(chunk),
      hash: simpleHash(chunk),
    },
  }));
}

function buildKcsExport(chunks: KcsChunk[], format: "json" | "jsonl"): string {
  if (format === "jsonl") {
    return chunks.map((chunk) => JSON.stringify(chunk)).join("\n");
  }
  return JSON.stringify(chunks, null, 2);
}

function parseKcsUpload(text: string): { raw: string; chunks: KcsChunk[] } {
  const trimmed = text.trim();
  if (!trimmed) {
    return { raw: "", chunks: [] };
  }

  let parsed: unknown;

  if (trimmed.startsWith("{")) {
    parsed = trimmed.split(/\n+/).map((line) => JSON.parse(line));
  } else if (trimmed.startsWith("[")) {
    parsed = JSON.parse(trimmed);
  } else {
    parsed = trimmed.split(/\n+/).map((line) => JSON.parse(line));
  }

  const normalized = Array.isArray(parsed) ? parsed : [];
  const fallbackTimestamp = new Date().toISOString();
  const assembledChunks: KcsChunk[] = normalized.map((entry, index) => {
    const candidate = entry as Partial<KcsChunk> & { content?: string; metadata?: Partial<KcsChunk["metadata"]> };
    const content = candidate.content ?? "";
    return {
      id: candidate.id ?? createId(),
      content,
      metadata: {
        chunkIndex: candidate.metadata?.chunkIndex ?? index,
        createdAt: candidate.metadata?.createdAt ?? fallbackTimestamp,
        source: candidate.metadata?.source ?? "uploaded",
        tokenEstimate: candidate.metadata?.tokenEstimate ?? estimateTokens(content),
        hash: candidate.metadata?.hash ?? simpleHash(content),
      },
    };
  });

  const raw = assembledChunks.map((chunk) => chunk.content).join("\n\n");
  return { raw, chunks: assembledChunks };
}

function downloadBlob(filename: string, payload: string, mime = "text/plain") {
  const blob = new Blob([payload], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export default function Home() {
  const [hydrated, setHydrated] = useState(false);
  const [taskInput, setTaskInput] = useState("");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [irRaw, setIrRaw] = useState("");
  const [irMarkdown, setIrMarkdown] = useState("");
  const [kcsRaw, setKcsRaw] = useState("");
  const [kcsChunks, setKcsChunks] = useState<KcsChunk[]>([]);
  const [exportFormat, setExportFormat] = useState<"json" | "jsonl">("json");
  const [kcsStatus, setKcsStatus] = useState("");

  useEffect(() => {
    if (typeof window === "undefined") return;

    try {
      const storedTasks = localStorage.getItem(TASKS_STORAGE_KEY);
      const storedIr = localStorage.getItem(IR_STORAGE_KEY);
      const storedIrMd = localStorage.getItem(IR_MD_STORAGE_KEY);
      const storedKcs = localStorage.getItem(KCS_STORAGE_KEY);
      const storedKcsChunks = localStorage.getItem(KCS_CHUNKS_KEY);

      if (storedTasks) {
        setTasks(JSON.parse(storedTasks));
      }
      if (storedIr) {
        setIrRaw(storedIr);
      }
      if (storedIrMd) {
        setIrMarkdown(storedIrMd);
      }
      if (storedKcs) {
        setKcsRaw(storedKcs);
      }
      if (storedKcsChunks) {
        setKcsChunks(JSON.parse(storedKcsChunks));
      }
    } catch (error) {
      console.error("Failed to hydrate data", error);
    }

    setHydrated(true);
  }, []);

  useEffect(() => {
    setIrMarkdown(convertIrToMarkdown(irRaw));
  }, [irRaw]);

  useEffect(() => {
    if (!hydrated || typeof window === "undefined") return;
    localStorage.setItem(TASKS_STORAGE_KEY, JSON.stringify(tasks));
  }, [tasks, hydrated]);

  useEffect(() => {
    if (!hydrated || typeof window === "undefined") return;
    localStorage.setItem(IR_STORAGE_KEY, irRaw);
    localStorage.setItem(IR_MD_STORAGE_KEY, irMarkdown);
  }, [irRaw, irMarkdown, hydrated]);

  useEffect(() => {
    if (!hydrated || typeof window === "undefined") return;
    localStorage.setItem(KCS_STORAGE_KEY, kcsRaw);
    localStorage.setItem(KCS_CHUNKS_KEY, JSON.stringify(kcsChunks));
  }, [kcsRaw, kcsChunks, hydrated]);

  const groupedTasks = useMemo(() => {
    const groups: Record<string, Task[]> = {
      "true-true": [],
      "true-false": [],
      "false-true": [],
      "false-false": [],
    };

    tasks
      .slice()
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
      .forEach((task) => {
        const key = `${task.urgent}-${task.important}`;
        groups[key].push(task);
      });

    return groups;
  }, [tasks]);

  const handleTaskSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = taskInput.trim();
    if (!trimmed) return;

    const classification = classifyTask(trimmed);
    const nextTask: Task = {
      id: createId(),
      title: trimmed,
      urgent: classification.urgent,
      important: classification.important,
      rationale: classification.rationale,
      completed: false,
      createdAt: new Date().toISOString(),
    };

    setTasks((current) => [nextTask, ...current]);
    setTaskInput("");
  };

  const handleTaskQuadrantChange = (task: Task, urgent: boolean, important: boolean) => {
    setTasks((current) =>
      current.map((entry) =>
        entry.id === task.id
          ? {
              ...entry,
              urgent,
              important,
            }
          : entry,
      ),
    );
  };

  const toggleTaskCompletion = (task: Task) => {
    setTasks((current) =>
      current.map((entry) =>
        entry.id === task.id
          ? {
              ...entry,
              completed: !entry.completed,
            }
          : entry,
      ),
    );
  };

  const removeTask = (task: Task) => {
    setTasks((current) => current.filter((entry) => entry.id !== task.id));
  };

  const handleIrUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const text = await file.text();
    setIrRaw(text);
    event.target.value = "";
  };

  const handleIrDownload = () => {
    if (!irMarkdown.trim()) return;
    downloadBlob("instructional-ruleset.md", irMarkdown, "text/markdown");
  };

  const handleKcsUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      const content = await file.text();
      const { raw, chunks } = parseKcsUpload(content);
      setKcsRaw(raw);
      setKcsChunks(chunks);
      setKcsStatus(`Imported ${chunks.length} knowledge chunks`);
    } catch (error) {
      console.error("Failed to import KCS", error);
      setKcsStatus("Upload failed. Check file format.");
    }

    event.target.value = "";
  };

  const handleKcsChunking = () => {
    const chunks = chunkKnowledgeBase(kcsRaw);
    setKcsChunks(chunks);
    setKcsStatus(`Generated ${chunks.length} knowledge chunks`);
  };

  const handleKcsExport = () => {
    if (!kcsChunks.length) return;
    const payload = buildKcsExport(kcsChunks, exportFormat);
    const extension = exportFormat === "jsonl" ? "jsonl" : "json";
    downloadBlob(`knowledge-compendium.${extension}`, payload, "application/json");
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 text-slate-100">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-10 px-4 py-10 sm:px-6 lg:px-10 lg:py-16">
        <header className="space-y-3">
          <p className="text-sm font-medium uppercase tracking-[0.2em] text-slate-400">
            Agentic Focus Console
          </p>
          <h1 className="text-4xl font-semibold text-white md:text-5xl">
            Eisenhower Matrix &amp; AI Blueprint Workspace
          </h1>
          <p className="max-w-3xl text-base leading-relaxed text-slate-300">
            Capture tasks, prioritize by urgency and importance, and author your custom AI model
            blueprint with Instructional Rulesets and Knowledge Compendium Synthesis in one unified dashboard.
          </p>
        </header>

        <div className="grid gap-8 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
          <section className="rounded-3xl border border-slate-800/60 bg-slate-900/70 p-6 shadow-2xl shadow-purple-950/40 backdrop-blur">
            <div className="mb-6 flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <h2 className="text-2xl font-semibold text-white">Eisenhower Matrix Task Tracker</h2>
                <p className="text-sm text-slate-400">
                  Type a task outside the matrix; the classifier routes it based on urgency cues.
                  Refine placement manually any time.
                </p>
              </div>
              <form onSubmit={handleTaskSubmit} className="flex flex-col gap-3 sm:flex-row">
                <input
                  value={taskInput}
                  onChange={(event) => setTaskInput(event.target.value)}
                  placeholder="Describe the task with any timing or priority cues..."
                  className="h-12 flex-1 rounded-full border border-slate-700/60 bg-slate-950/80 px-5 text-sm text-slate-100 placeholder:text-slate-500 focus:border-purple-400 focus:outline-none focus:ring-2 focus:ring-purple-500/40"
                />
                <button
                  type="submit"
                  className="inline-flex h-12 items-center justify-center rounded-full bg-purple-500 px-6 text-sm font-semibold text-white transition hover:bg-purple-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-300"
                >
                  Capture Task
                </button>
              </form>
            </div>

            <div className="relative">
              <div className="rounded-[2.25rem] border border-slate-800 bg-slate-950/60 p-5 shadow-inner shadow-black/50">
                <div className="grid h-[560px] grid-cols-1 gap-4 md:grid-cols-2 md:grid-rows-2">
                  {Object.entries(groupedTasks).map(([key, quadrantTasks]) => {
                    const [urgentKey, importantKey] = key.split("-") as ["true" | "false", "true" | "false"];
                    return (
                      <div
                        key={key}
                        className="flex flex-col rounded-3xl border border-slate-800/70 bg-slate-900/70 p-4"
                      >
                        <div className="flex items-center justify-between">
                          <div>
                            <p className="text-xs uppercase tracking-[0.3em] text-slate-500">
                              {urgentLabels[urgentKey]} · {importantLabels[importantKey]}
                            </p>
                            <h3 className="mt-1 text-lg font-semibold text-white">
                              {quadrantTitles[key]}
                            </h3>
                          </div>
                          <span className="rounded-full bg-slate-800 px-3 py-1 text-xs text-slate-300">
                            {quadrantTasks.length} tasks
                          </span>
                        </div>

                        <div className="mt-4 flex-1 space-y-3 overflow-y-auto pr-2">
                          {quadrantTasks.length === 0 ? (
                            <p className="text-xs text-slate-500">Nothing here yet. Keep capturing tasks.</p>
                          ) : (
                            quadrantTasks.map((task) => (
                              <div
                                key={task.id}
                                className={`rounded-2xl border border-slate-800/80 bg-slate-950/80 p-3 transition ${
                                  task.completed ? "opacity-60" : "opacity-100"
                                }`}
                              >
                                <div className="flex items-start justify-between gap-3">
                                  <div className="flex flex-1 gap-3">
                                    <input
                                      type="checkbox"
                                      checked={task.completed}
                                      onChange={() => toggleTaskCompletion(task)}
                                      className="mt-1 h-4 w-4 rounded border-slate-700 bg-slate-900 text-purple-500 focus:ring-purple-400"
                                    />
                                    <div className="space-y-1">
                                      <p
                                        className={`text-sm font-medium ${
                                          task.completed ? "line-through text-slate-500" : "text-slate-100"
                                        }`}
                                      >
                                        {task.title}
                                      </p>
                                      <p className="text-xs text-slate-500">{task.rationale}</p>
                                    </div>
                                  </div>
                                  <button
                                    type="button"
                                    onClick={() => removeTask(task)}
                                    className="rounded-full p-1 text-slate-500 transition hover:bg-slate-800 hover:text-slate-200"
                                    aria-label="Remove task"
                                  >
                                    ×
                                  </button>
                                </div>
                                <div className="mt-3 flex flex-wrap items-center gap-3 text-[11px] text-slate-400">
                                  <label className="flex items-center gap-1">
                                    Urgent
                                    <input
                                      type="checkbox"
                                      checked={task.urgent}
                                      onChange={(event) =>
                                        handleTaskQuadrantChange(task, event.target.checked, task.important)
                                      }
                                      className="h-3.5 w-3.5 rounded border-slate-700 bg-slate-900 text-purple-500 focus:ring-purple-300"
                                    />
                                  </label>
                                  <label className="flex items-center gap-1">
                                    Important
                                    <input
                                      type="checkbox"
                                      checked={task.important}
                                      onChange={(event) =>
                                        handleTaskQuadrantChange(task, task.urgent, event.target.checked)
                                      }
                                      className="h-3.5 w-3.5 rounded border-slate-700 bg-slate-900 text-purple-500 focus:ring-purple-300"
                                    />
                                  </label>
                                  <span className="rounded-full bg-slate-800/80 px-2 py-0.5">
                                    {new Date(task.createdAt).toLocaleString()}
                                  </span>
                                </div>
                              </div>
                            ))
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </section>

          <section className="flex flex-col gap-6 rounded-3xl border border-slate-800/60 bg-slate-900/70 p-6 shadow-2xl shadow-purple-950/40 backdrop-blur">
            <div>
              <h2 className="text-2xl font-semibold text-white">Gemini Blueprint Composer</h2>
              <p className="mt-1 text-sm text-slate-400">
                Store Instructional Rulesets (converted to Markdown) and a chunked Knowledge Compendium
                ready for JSON or JSONL export.
              </p>
            </div>

            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold uppercase tracking-[0.25em] text-slate-400">
                  Instructional Ruleset (IR)
                </h3>
                <div className="flex items-center gap-2 text-xs text-slate-500">
                  <label className="cursor-pointer rounded-full border border-slate-700/70 px-3 py-1 hover:border-purple-400">
                    Upload
                    <input
                      type="file"
                      accept=".txt,.md,.markdown"
                      onChange={handleIrUpload}
                      className="hidden"
                    />
                  </label>
                  <button
                    type="button"
                    onClick={handleIrDownload}
                    className="rounded-full border border-purple-500 px-3 py-1 text-purple-300 transition hover:bg-purple-500/10"
                  >
                    Export Markdown
                  </button>
                </div>
              </div>
              <textarea
                value={irRaw}
                onChange={(event) => setIrRaw(event.target.value)}
                placeholder="Define persona, tone, guardrails, decision protocols..."
                className="min-h-[180px] w-full rounded-2xl border border-slate-800/70 bg-slate-950/70 p-4 text-sm text-slate-100 placeholder:text-slate-500 focus:border-purple-400 focus:outline-none focus:ring-2 focus:ring-purple-500/40"
              />
              <div className="rounded-2xl border border-slate-800/60 bg-slate-950/60 p-4">
                <p className="mb-2 text-xs font-semibold uppercase tracking-[0.3em] text-slate-500">
                  Markdown Preview
                </p>
                <div className="prose prose-invert max-w-none text-sm">
                  {irMarkdown ? (
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{irMarkdown}</ReactMarkdown>
                  ) : (
                    <p className="text-slate-500">Nothing to preview yet.</p>
                  )}
                </div>
              </div>
            </div>

            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold uppercase tracking-[0.25em] text-slate-400">
                  Knowledge Compendium Synthesis (KCS)
                </h3>
                <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                  <label className="cursor-pointer rounded-full border border-slate-700/70 px-3 py-1 hover:border-purple-400">
                    Upload
                    <input
                      type="file"
                      accept=".txt,.json,.jsonl"
                      onChange={handleKcsUpload}
                      className="hidden"
                    />
                  </label>
                  <select
                    value={exportFormat}
                    onChange={(event) => setExportFormat(event.target.value as "json" | "jsonl")}
                    className="rounded-full border border-slate-700/70 bg-slate-950/80 px-3 py-1 text-slate-200 focus:border-purple-400 focus:outline-none"
                  >
                    <option value="json">Export JSON</option>
                    <option value="jsonl">Export JSONL</option>
                  </select>
                  <button
                    type="button"
                    onClick={handleKcsExport}
                    className="rounded-full border border-purple-500 px-3 py-1 text-purple-300 transition hover:bg-purple-500/10"
                  >
                    Export
                  </button>
                </div>
              </div>
              <textarea
                value={kcsRaw}
                onChange={(event) => setKcsRaw(event.target.value)}
                placeholder="Paste research, process knowledge, and reference material to synthesize..."
                className="min-h-[180px] w-full rounded-2xl border border-slate-800/70 bg-slate-950/70 p-4 text-sm text-slate-100 placeholder:text-slate-500 focus:border-purple-400 focus:outline-none focus:ring-2 focus:ring-purple-500/40"
              />
              <div className="flex flex-wrap items-center gap-3 text-xs text-slate-400">
                <button
                  type="button"
                  onClick={handleKcsChunking}
                  className="rounded-full bg-purple-500/10 px-4 py-2 font-medium text-purple-200 transition hover:bg-purple-500/20"
                >
                  Chunk &amp; Map Knowledge
                </button>
                {kcsStatus && <span className="text-slate-300">{kcsStatus}</span>}
              </div>
              <div className="max-h-64 overflow-y-auto rounded-2xl border border-slate-800/60 bg-slate-950/60 p-4 text-sm text-slate-200">
                {kcsChunks.length === 0 ? (
                  <p className="text-slate-500">No KCS chunks generated yet.</p>
                ) : (
                  <ul className="space-y-3">
                    {kcsChunks.map((chunk) => (
                      <li key={chunk.id} className="rounded-xl border border-slate-800/60 bg-slate-900/70 p-3">
                        <div className="flex items-center justify-between text-xs text-slate-400">
                          <span>Chunk #{chunk.metadata.chunkIndex + 1}</span>
                          <span>{chunk.metadata.tokenEstimate} tokens est.</span>
                        </div>
                        <p className="mt-2 whitespace-pre-wrap text-slate-200">{chunk.content}</p>
                        <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-slate-500">
                          <span className="rounded-full bg-slate-800/60 px-2 py-0.5">{chunk.metadata.source}</span>
                          <span className="rounded-full bg-slate-800/60 px-2 py-0.5">hash:{chunk.metadata.hash}</span>
                          <span className="rounded-full bg-slate-800/60 px-2 py-0.5">
                            {new Date(chunk.metadata.createdAt).toLocaleString()}
                          </span>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
