import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Inbox } from "lucide-react";
import { type FormEvent, useState } from "react";
import { sentApi } from "./api";

export function LoginPage() {
  const queryClient = useQueryClient();
  const [password, setPassword] = useState("");
  const login = useMutation({
    mutationFn: () => sentApi.login(password),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["session"] }),
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    login.mutate();
  };
  return (
    <main className="login-page">
      <section className="login-card">
        <div className="login-mark">
          <Inbox size={23} strokeWidth={1.7} />
        </div>
        <span className="eyebrow">Private mail</span>
        <h1>Welcome to Sent.</h1>
        <p>Your important mail, without the weight of everything else.</p>
        <form onSubmit={submit}>
          <label htmlFor="password">Password</label>
          <div className="password-field">
            <input
              id="password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoFocus
              autoComplete="current-password"
            />
            <button type="submit" disabled={!password || login.isPending} aria-label="Sign in">
              <ArrowRight size={19} />
            </button>
          </div>
          {login.isError && <p className="form-error">{login.error.message}</p>}
        </form>
      </section>
    </main>
  );
}
