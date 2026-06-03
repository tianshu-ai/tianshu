import { useEffect, useState } from "react";

type Health = { status: string; name: string; version: string; uptimeSec: number };

export default function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then(setHealth)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  return (
    <main className="mx-auto max-w-2xl p-8">
      <header className="mb-8">
        <h1 className="text-3xl font-semibold tracking-tight">
          天枢 · <span className="text-amber-300">Tianshu</span>
        </h1>
        <p className="mt-2 text-slate-400">
          An open AI agent platform with a sidecar browser. Built in public.
        </p>
      </header>

      <section className="rounded-lg border border-slate-800 bg-slate-900/60 p-4">
        <h2 className="text-sm font-medium uppercase tracking-wider text-slate-400">
          Server health
        </h2>
        {error && <pre className="mt-2 text-rose-400">{error}</pre>}
        {health && (
          <pre className="mt-2 overflow-auto text-sm text-emerald-300">
            {JSON.stringify(health, null, 2)}
          </pre>
        )}
        {!health && !error && <p className="mt-2 text-slate-500">checking…</p>}
      </section>

      <footer className="mt-8 text-sm text-slate-500">
        Day 0. Real UI lands soon.{" "}
        <a
          className="text-amber-300 hover:underline"
          href="https://github.com/tianshu-ai/tianshu"
        >
          GitHub →
        </a>
      </footer>
    </main>
  );
}
