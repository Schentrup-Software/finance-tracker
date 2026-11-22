import { isRouteErrorResponse, Links, Meta, Outlet, Scripts, ScrollRestoration } from "react-router";

import type { Route } from "./+types/root";
import "./app.css";

export const links: Route.LinksFunction = () => [
  { rel: "preconnect", href: "https://fonts.googleapis.com" },
  { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
  {
    rel: "stylesheet",
    href: "https://fonts.googleapis.com/css2?family=Nunito:wght@500;600;700;800;900&display=swap",
  },
  { rel: "icon", type: "image/svg+xml", href: "/icon.svg" },
  { rel: "manifest", href: "/manifest.json" },
];

export function meta() {
  return [{ title: "Finance Tracker" }];
}

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <meta name="theme-color" content="#fff7ee" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <Meta />
        <Links />
      </head>
      <body className="font-sans antialiased">
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

export function HydrateFallback() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="bob text-6xl" aria-label="Loading">🐷</div>
    </div>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let message = "Oops!";
  let details = "Something went wrong.";
  let stack: string | undefined;

  if (isRouteErrorResponse(error)) {
    message = error.status === 404 ? "Page not found" : "Error";
    details = error.status === 404 ? "There's nothing here." : error.statusText || details;
  } else if (import.meta.env.DEV && error instanceof Error) {
    details = error.message;
    stack = error.stack;
  }

  return (
    <main className="mx-auto max-w-xl p-6 pt-20 text-center">
      <div className="text-6xl">🙈</div>
      <h1 className="mt-4 text-3xl font-black">{message}</h1>
      <p className="mt-2 font-semibold">{details}</p>
      <a href="/budget" className="btn c-lilac mt-6">Back to the budget</a>
      {stack && <pre className="mt-6 overflow-x-auto text-left text-xs">{stack}</pre>}
    </main>
  );
}
