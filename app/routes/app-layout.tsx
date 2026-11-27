import { useEffect } from "react";
import { NavLink, Outlet, redirect, useNavigate } from "react-router";
import { currentUserEmail, isSignedIn, needsSimplefinStep, refreshAuth, signOut } from "~/backend/api";
import { RoundButton, cx } from "~/components/ui";
import { PiggyLogo } from "~/components/PiggyLogo";

export async function clientLoader({ request }: { request: Request }) {
  if (!isSignedIn()) throw redirect("/login");
  // Onboarding starts with SimpleFIN: until the household connects it or skips it, every
  // household (new or not) lands on the Bank accounts page first.
  if (new URL(request.url).pathname !== "/accounts" && (await needsSimplefinStep())) {
    throw redirect("/accounts?welcome=1");
  }
  return null;
}

const TABS = [
  { to: "/budget", label: "Budget", emoji: "✉️", color: "mint" },
  { to: "/debts", label: "Debts", emoji: "⛓️", color: "coral" },
  { to: "/assets", label: "Assets", emoji: "🏡", color: "sky" },
] as const;

export default function AppLayout() {
  const navigate = useNavigate();

  // A stored token may have expired or been revoked since the last visit.
  useEffect(() => {
    refreshAuth().then((ok) => !ok && navigate("/login", { replace: true }));
  }, [navigate]);

  return (
    <div className="min-h-screen pb-16">
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between gap-2 px-4 pt-5 sm:gap-4 sm:px-6">
        <div className="flex min-w-0 items-center gap-2 sm:gap-3">
          <PiggyLogo className="h-9 w-9 flex-none sm:h-14 sm:w-14" />
          <h1 className="text-lg font-black leading-tight tracking-tight sm:text-4xl">Finance Tracker</h1>
        </div>
        {/* Phones fit the four round buttons by making them a little smaller (still 44px, a full tap target). */}
        <div className="flex flex-none items-center gap-1.5 sm:gap-3 [&>.round-btn]:h-11 [&>.round-btn]:w-11 sm:[&>.round-btn]:h-12 sm:[&>.round-btn]:w-12">
          <span className="hidden text-sm font-bold opacity-70 md:inline">{currentUserEmail()}</span>
          <RoundButton label="Bank accounts" icon="bank" onClick={() => navigate("/accounts")} />
          <RoundButton label="Household" icon="people" onClick={() => navigate("/household")} />
          <RoundButton label="API tokens" icon="key" onClick={() => navigate("/api-tokens")} />
          <RoundButton label="Sign out" icon="logout" onClick={() => { signOut(); navigate("/login"); }} />
        </div>
      </header>

      <nav aria-label="Sections" className="sticky top-0 z-30 mx-auto mt-2 w-full max-w-6xl px-4 py-3 sm:mt-4 sm:px-6">
        <div className="tray grid grid-cols-3 gap-2 p-2 backdrop-blur sm:gap-3 sm:p-3">
          {TABS.map((t) => (
            <NavLink key={t.to} to={t.to}
              className={({ isActive }) => cx(
                "flex min-w-0 items-center justify-center gap-1.5 rounded-[22px] px-2 py-3 text-base font-black transition-all sm:gap-2 sm:px-3 sm:text-xl",
                `c-${t.color}`,
                isActive ? "chunk translate-y-0" : "opacity-70 hover:bg-white/70 hover:opacity-100",
              )}
              style={({ isActive }) => (isActive ? { borderRadius: 22, boxShadow: "0 6px 0 var(--cd)" } : undefined)}
            >
              <span aria-hidden="true">{t.emoji}</span>
              {t.label}
            </NavLink>
          ))}
        </div>
      </nav>

      <main className="mx-auto w-full max-w-6xl px-4 pt-4 sm:px-6">
        <Outlet />
      </main>
    </div>
  );
}
