# Runtime modes

Pied Piper has a global runtime mode switch in the chat toolbar:

- **Full access** (default): starts sessions with `approvalPolicy: never` and `sandboxMode: danger-full-access`.
- **Supervised**: starts sessions with `approvalPolicy: untrusted` and `sandboxMode: read-only`, then prompts in-app for command/file approvals. An approved write may prompt a second time if the model has to escalate out of the sandbox.
