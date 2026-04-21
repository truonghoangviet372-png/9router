"use client";

import { useState } from "react";
import PropTypes from "prop-types";
import { Modal, Button } from "@/shared/components";

/**
 * Codex Session Import Modal
 * Accepts JSON from chatgpt.com/api/auth/session (or direct access token string).
 */
export default function CodexSessionModal({ isOpen, onSuccess, onClose }) {
  const [sessionInput, setSessionInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const handleClose = () => {
    if (loading) return;
    setSessionInput("");
    setError(null);
    onClose?.();
  };

  const handleSubmit = async () => {
    if (!sessionInput.trim()) {
      setError("Please paste session JSON (or access token)");
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/oauth/codex/import-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session: sessionInput.trim() }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Import failed");

      onSuccess?.(data.connection);
      handleClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="Import Codex Session" size="lg">
      <div className="space-y-4">
        <p className="text-sm text-text-muted">
          Paste full JSON from <code className="px-1 rounded bg-black/5 dark:bg-white/5">https://chatgpt.com/api/auth/session</code>
          {" "}or paste a direct <code className="px-1 rounded bg-black/5 dark:bg-white/5">accessToken</code>.
        </p>

        <textarea
          value={sessionInput}
          onChange={(e) => setSessionInput(e.target.value)}
          placeholder='{"accessToken":"...","user":{"email":"..."}}'
          className="w-full min-h-[200px] px-3 py-2 text-sm font-mono border border-border rounded-lg bg-background focus:outline-none focus:border-primary resize-y"
          disabled={loading}
        />

        {error && (
          <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
            <p className="text-sm text-red-600 dark:text-red-400 break-words">{error}</p>
          </div>
        )}

        <div className="flex gap-2">
          <Button onClick={handleSubmit} fullWidth disabled={loading || !sessionInput.trim()}>
            {loading ? "Importing..." : "Import Session"}
          </Button>
          <Button onClick={handleClose} variant="ghost" fullWidth disabled={loading}>
            Cancel
          </Button>
        </div>
      </div>
    </Modal>
  );
}

CodexSessionModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onSuccess: PropTypes.func,
  onClose: PropTypes.func,
};
