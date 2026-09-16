import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { FileUp } from "lucide-react";
import { api } from "../lib/ipc";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

interface Props {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onImported: () => void;
}

export function ImportDialog({ open: isOpen, onOpenChange, onImported }: Props) {
  const [path, setPath] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setPath(null);
      setPassword("");
      setBusy(false);
      setError(null);
      setResult(null);
    }
  }, [isOpen]);

  async function pick() {
    const sel = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "KeePass database", extensions: ["kdbx"] }],
    });
    if (typeof sel === "string") setPath(sel);
  }

  async function run() {
    if (!path) return setError("Choose a .kdbx file first.");
    setBusy(true);
    setError(null);
    try {
      const msg = await api.importKdbx(path, password);
      setResult(msg);
      onImported();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  const fileName = path?.split("/").pop() ?? null;

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent className="gap-3 sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Import from KeePass</DialogTitle>
        </DialogHeader>

        {result ? (
          <p className="rounded-lg border border-border bg-card px-3 py-2 text-sm text-primary">{result}</p>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              Import all entries from a KeePassXC <span className="font-mono">.kdbx</span> file. Passwords and 2FA
              secrets are stored in your OS keychain, just like native entries.
            </p>

            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Database file</label>
              <div className="flex gap-2">
                <Input
                  readOnly
                  value={fileName ?? ""}
                  placeholder="No file selected"
                  onClick={pick}
                  className="cursor-pointer"
                />
                <Button type="button" variant="outline" onClick={pick}>
                  <FileUp className="size-4" /> Browse
                </Button>
              </div>
            </div>

            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Master password</label>
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="KeePass master password"
                onKeyDown={(e) => e.key === "Enter" && run()}
              />
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}
          </>
        )}

        <DialogFooter>
          {result ? (
            <Button onClick={() => onOpenChange(false)}>Done</Button>
          ) : (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button onClick={run} disabled={busy || !path}>{busy ? "Importing…" : "Import"}</Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
