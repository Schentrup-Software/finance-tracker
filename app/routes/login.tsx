import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { errorMessage, isSignedIn, signIn, signUp, signupOpen } from "~/backend/api";
import { Card, ErrorNote, TextInput } from "~/components/ui";
import { PiggyLogo } from "~/components/PiggyLogo";

export function meta() {
  return [{ title: "Sign in · Finance Tracker" }];
}

export default function Login() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<"loading" | "signin" | "setup">("loading");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (isSignedIn()) {
      navigate("/budget", { replace: true });
      return;
    }
    signupOpen().then((open) => setMode(open ? "setup" : "signin"));
  }, [navigate]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === "setup") await signUp(email.trim(), password);
      else await signIn(email.trim(), password);
      navigate("/budget", { replace: true });
    } catch (err: any) {
      setError(err?.status === 400 && mode === "signin" ? "That email and password don't match." : errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <Card className="pop-in w-full max-w-md p-8">
        <div className="flex flex-col items-center text-center">
          <PiggyLogo className="bob h-24 w-24" />
          <h1 className="mt-4 text-3xl font-black">Finance Tracker</h1>
          <p className="mt-1 font-semibold opacity-75">
            {mode === "setup"
              ? "Welcome! Create the account for this tracker. After this, sign-up closes."
              : "Budgets, debts and assets, all in one place."}
          </p>
        </div>

        {mode !== "loading" && (
          <form onSubmit={submit} className="mt-6 space-y-4">
            <TextInput label="Email" type="email" autoComplete="email" required value={email}
              onChange={(e) => setEmail(e.target.value)} />
            <TextInput label="Password" type="password" required minLength={8}
              autoComplete={mode === "setup" ? "new-password" : "current-password"}
              hint={mode === "setup" ? "At least 8 characters." : undefined}
              value={password} onChange={(e) => setPassword(e.target.value)} />
            <ErrorNote message={error} />
            <button type="submit" className="btn c-mint w-full text-lg" disabled={busy}>
              {busy ? "One moment…" : mode === "setup" ? "Create account" : "Sign in"}
            </button>
          </form>
        )}
      </Card>
    </main>
  );
}
