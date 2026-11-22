import { useEffect } from "react";
import { NavLink, Outlet, redirect, useNavigate } from "react-router";
import { currentUserEmail, isSignedIn, refreshAuth, signOut } from "~/backend/api";
import { RoundButton, cx } from "~/components/ui";
import { PiggyLogo } from "~/components/PiggyLogo";

export async function clientLoader() {
  if (!isSignedIn()) throw redirect("/login");
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
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-4 pt-5 sm:px-6">
        <div className="flex items-center gap-3">
          <PiggyLogo className="h-12 w-12 sm:h-14 sm:w-14" />
          <h1 className="text-2xl font-black tracking-tight sm:text-4xl">Finance Tracker</h1>
        </div>
        <div className="flex items-center gap-3">
          <span className="hidden text-sm font-bold opacity-70 md:inline">{currentUserEmail()}</span>
          <RoundButton label="Sign out" icon="logout" onClick={() => { signOut(); navigate("/login"); }} />
        </div>
      </header>

      <nav aria-label="Sections" className="sticky top-0 z-30 mx-auto mt-4 w-full max-w-6xl px-4 py-3 sm:px-6">
        <div className="tray grid grid-cols-3 gap-2 p-2 backdrop-blur sm:gap-3 sm:p-3">
          {TABS.map((t) => (
            <NavLink key={t.to} to={t.to}
              className={({ isActive }) => cx(
                "flex items-center justify-center gap-2 rounded-[22px] px-3 py-3 text-lg font-black transition-all sm:text-xl",
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
