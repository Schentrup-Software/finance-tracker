import { useCallback, useEffect, useState } from "react";
import {
  addMember, errorMessage, isHouseholdHead, listHousehold, removeMember, setMemberPassword, updateMyName, type Member,
} from "~/backend/api";
import { Button, Card, ErrorNote, FormActions, Icon, Modal, SectionTitle, TextInput, cx } from "~/components/ui";

export function meta() {
  return [{ title: "Household · Finance Tracker" }];
}

const HUES = ["mint", "sky", "peach", "lilac", "pink", "butter", "aqua", "coral"];

export default function HouseholdPage() {
  const [members, setMembers] = useState<Member[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [resetting, setResetting] = useState<Member | null>(null);
  const [renaming, setRenaming] = useState(false);
  const head = isHouseholdHead();

  const reload = useCallback(async () => {
    try {
      setMembers(await listHousehold());
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);
  useEffect(() => { reload(); }, [reload]);

  async function remove(m: Member) {
    if (!window.confirm(`Remove ${m.name || m.email} from the household? They won't be able to sign in. The budget, debts and assets stay.`)) return;
    try {
      await removeMember(m.id);
      reload();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  const me = members?.find((m) => m.isMe);

  return (
    <div className="mx-auto max-w-3xl">
      <SectionTitle action={head && (
        <Button small color="mint" onClick={() => setAdding(true)}><Icon name="plus" className="h-5 w-5" /> Add a person</Button>
      )}>Your household</SectionTitle>
      <p className="-mt-2 mb-5 font-semibold opacity-80">
        Everyone here shares the same budget, debts and assets, and can add and change them.
        {head ? " As head of the household, you add and remove people." : " The head of the household adds and removes people."}
      </p>
      <ErrorNote message={error} />

      {!members ? (
        <div className="py-16 text-center text-5xl"><span className="bob inline-block">🏡</span></div>
      ) : (
        <ul className="space-y-3">
          {members.map((m, i) => (
            <li key={m.id}>
              <Card className={cx("pop-in flex flex-wrap items-center gap-4 p-4")} style={{ ["--i" as any]: i }}>
                <span className={cx("flex h-12 w-12 flex-none items-center justify-center rounded-full text-xl font-black", `c-${HUES[i % HUES.length]}`)}
                  style={{ background: "var(--c)" }} aria-hidden="true">
                  {(m.name || m.email).slice(0, 1).toUpperCase()}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-lg font-black">
                    {m.name || m.email.split("@")[0]}
                    {m.isMe && <span className="ml-2 text-sm font-bold opacity-60">(you)</span>}
                  </div>
                  <div className="truncate text-sm font-bold opacity-70">{m.email}</div>
                </div>
                {m.isHead && <span className="pill c-butter">Head of household</span>}
                <div className="flex gap-2">
                  {m.isMe && <button className="btn-ghost text-sm" onClick={() => setRenaming(true)}><Icon name="edit" className="h-4 w-4" /> Name</button>}
                  {head && !m.isHead && (
                    <>
                      <button className="btn-ghost text-sm" onClick={() => setResetting(m)}>New password</button>
                      <button className="btn-ghost text-sm" onClick={() => remove(m)} aria-label={`Remove ${m.name || m.email}`}>
                        <Icon name="trash" className="h-4 w-4" /> Remove
                      </button>
                    </>
                  )}
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}

      <AddMember open={adding} onClose={() => setAdding(false)} onAdded={reload} />
      <ResetPassword member={resetting} onClose={() => setResetting(null)} />
      <RenameMe open={renaming} name={me?.name ?? ""} onClose={() => setRenaming(false)} onSaved={reload} />
    </div>
  );
}

function AddMember({ open, onClose, onAdded }: { open: boolean; onClose: () => void; onAdded: () => void }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (open) { setName(""); setEmail(""); setPassword(""); setError(null); } }, [open]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await addMember({ name: name.trim(), email: email.trim(), password });
      onAdded();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} title="Add a person" onClose={onClose} color="mint">
      <form onSubmit={save} className="space-y-4">
        <TextInput label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Brie" />
        <TextInput label="Email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        <TextInput label="Password" type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)}
          hint="At least 8 characters. Share it with them; they sign in with this email and password." />
        <ErrorNote message={error} />
        <FormActions saving={busy} submitLabel="Add to household" />
      </form>
    </Modal>
  );
}

function ResetPassword({ member, onClose }: { member: Member | null; onClose: () => void }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setPassword(""); setError(null); }, [member]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!member) return;
    setBusy(true);
    try {
      await setMemberPassword(member.id, password);
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={member !== null} title={`New password for ${member?.name || member?.email || ""}`} onClose={onClose}>
      <form onSubmit={save} className="space-y-4">
        <TextInput label="New password" type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} />
        <ErrorNote message={error} />
        <FormActions saving={busy} submitLabel="Set password" />
      </form>
    </Modal>
  );
}

function RenameMe({ open, name, onClose, onSaved }: { open: boolean; name: string; onClose: () => void; onSaved: () => void }) {
  const [value, setValue] = useState(name);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (open) { setValue(name); setError(null); } }, [open, name]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    try {
      await updateMyName(value.trim());
      onSaved();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <Modal open={open} title="Your name" onClose={onClose}>
      <form onSubmit={save} className="space-y-4">
        <TextInput label="Name" value={value} onChange={(e) => setValue(e.target.value)} />
        <ErrorNote message={error} />
        <FormActions />
      </form>
    </Modal>
  );
}
