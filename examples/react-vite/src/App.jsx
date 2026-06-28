import React, { useState } from 'react';

function App() {
  const [count, setCount] = useState(0);

  return (
    <div style={{ fontFamily: 'system-ui', textAlign: 'center', padding: '2rem' }}>
      <h1>Sandbox React + Vite</h1>
      <p>Running inside the sandbox with HMR support</p>
      <button
        onClick={() => setCount((c) => c + 1)}
        style={{
          padding: '0.75rem 1.5rem',
          fontSize: '1rem',
          borderRadius: '8px',
          border: '2px solid #2563eb',
          background: count > 0 ? '#2563eb' : 'transparent',
          color: count > 0 ? 'white' : '#2563eb',
          cursor: 'pointer',
        }}
      >
        Count: {count}
      </button>
    </div>
  );
}

export default App;
