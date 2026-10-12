/** Suspense boundary for print pages (they read the session and project per request). */
export default function Loading() {
  return <div className="min-h-screen bg-white p-6 text-sm text-neutral-600">Preparing the printable page…</div>;
}
