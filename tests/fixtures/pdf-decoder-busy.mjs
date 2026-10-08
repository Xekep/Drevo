// Benign unresponsive decoder: consumes CPU only in its child process.
setTimeout(() => { for (;;) { /* deadline must be enforced by the parent */ } }, 25);
