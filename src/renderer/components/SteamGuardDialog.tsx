import { useState } from 'react';
import type { SteamGuardRequest } from '../../shared/types';

interface Props {
  request: SteamGuardRequest;
  onSubmit: (code: string) => void;
  onCancel: () => void;
}

export default function SteamGuardDialog({ request, onSubmit, onCancel }: Props) {
  const [code, setCode] = useState('');
  const where = request.domain ? `the email Steam sent to your address at ${request.domain}` : 'the Steam Mobile app';
  return (
    <div className="modal-backdrop">
      <form
        className="modal"
        onSubmit={(e) => {
          e.preventDefault();
          if (code.trim()) onSubmit(code.trim());
        }}
      >
        <h2>Steam Guard code</h2>
        {request.lastCodeWrong && <p className="warn-text">That code didn't work. Try the newest one.</p>}
        <p>Enter the code from {where}.</p>
        <input autoFocus value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" spellCheck={false} />
        <div className="row-actions">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={!code.trim()}>
            Continue
          </button>
        </div>
      </form>
    </div>
  );
}
