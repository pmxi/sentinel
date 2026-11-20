import { createMutation, useQueryClient } from "@tanstack/solid-query";
import { createSignal, onMount } from "solid-js";
import { sentApi } from "./api";
export function LoginPage() {
  const queryClient = useQueryClient();
  const [password, setPassword] = createSignal("");
  let passwordInput: HTMLInputElement | undefined;
  onMount(() => passwordInput?.focus());
  const login = createMutation(() => ({
    mutationFn: () => sentApi.login(password()),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["session"] }),
  }));
  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    login.mutate();
  };
  return (
    <>
      {
        <main class="login-page">
          <section class="login-card">
            <h1>Sent</h1>
            <form onSubmit={submit}>
              <label for="password">Password</label>
              <div class="password-field">
                <input
                  id="password"
                  ref={passwordInput}
                  type="password"
                  value={password()}
                  onInput={(event) => setPassword(event.currentTarget.value)}
                  autofocus
                  autocomplete="current-password"
                />
                <button type="submit" disabled={!password() || login.isPending}>
                  Sign in
                </button>
              </div>
              {login.isError && <p class="form-error">{login.error.message}</p>}
            </form>
          </section>
        </main>
      }
    </>
  );
}
