export type ChatGPTOAuthState = "idle" | "starting" | "awaiting-return" | "connected" | "error";

export interface ConnectAccountProps {
  onStartChatGPTOAuth: () => void;
  onContinueToSprint: () => void;
  onRetryConnection: () => void;
  state: ChatGPTOAuthState;
  message?: string;
}

export default function ConnectAccount({
  onStartChatGPTOAuth,
  onContinueToSprint,
  onRetryConnection,
  state,
  message,
}: ConnectAccountProps) {
  const isConnecting = state === "starting" || state === "awaiting-return";
  const isConnected = state === "connected";

  return (
    <main className="connect-screen" aria-labelledby="connect-title">
      <div className="connect-screen__content">
        <h1 id="connect-title">Connect your Codex account</h1>
        <p className="connect-screen__intro">Use ChatGPT plan access to build your sprint plan.</p>
        <button
          className="button button--primary connect-action"
          type="button"
          onClick={isConnected ? onContinueToSprint : onStartChatGPTOAuth}
          disabled={isConnecting}
        >
          {isConnecting ? "Waiting for ChatGPT" : isConnected ? "Continue to sprint" : "Continue with ChatGPT"}
        </button>
        {state === "error" && (
          <button className="button button--quiet" type="button" onClick={onRetryConnection}>Retry connection</button>
        )}
        {message && <p className="connect-screen__status" role="status" aria-live="polite">{message}</p>}
      </div>
    </main>
  );
}
