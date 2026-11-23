import { createAuthClient } from "better-auth/react";
import { useSyncExternalStore } from "react";

import { isDesktop, LOCAL_USER } from "@/lib/edition";

export const authClient = createAuthClient();

export const { signIn, signOut, signUp, requestPasswordReset, resetPassword } = authClient;

const subscribeToHydration = () => () => {};
const clientSnapshot = () => true;
const serverSnapshot = () => false;

type SessionState = ReturnType<typeof authClient.useSession>;

// Kortes Desktop: always the local user, no sign-in.
const desktopSession = {
  data: { user: LOCAL_USER, session: { id: "local-session", userId: LOCAL_USER.id } },
  isPending: false,
  isRefetching: false,
  error: null,
  refetch: async () => {},
} as unknown as SessionState;

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- same signature as the web hook
function useDesktopSession(..._args: Parameters<typeof authClient.useSession>): SessionState {
  return desktopSession;
}

function useWebSession(...args: Parameters<typeof authClient.useSession>) {
  const session = authClient.useSession(...args);
  const hydrated = useSyncExternalStore(subscribeToHydration, clientSnapshot, serverSnapshot);

  // A sibling can resolve the shared auth store before this component hydrates.
  // Match the server's loading state until this consumer finishes hydration.
  return hydrated ? session : { ...session, data: null, isPending: true };
}

export const useSession = isDesktop ? useDesktopSession : useWebSession;
