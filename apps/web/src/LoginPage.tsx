import { useMutation, useQueryClient } from "@tanstack/react-query";
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
        <h1>Sent</h1>
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
            <button type="submit" disabled={!password || login.isPending}>
              Sign in
            </button>
          </div>
          {login.isError && <p className="form-error">{login.error.message}</p>}
        </form>
      </section>
    </main>
  );
}
