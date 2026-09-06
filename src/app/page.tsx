export default function Home() {
  return (
    <main style={{ fontFamily: "monospace", padding: "2rem", maxWidth: 720 }}>
      <h1>ai-thun</h1>
      <p>SEA-LION AI endpoint. POST your requests to:</p>
      <pre
        style={{
          background: "#111",
          color: "#0f0",
          padding: "1rem",
          borderRadius: 8,
          overflowX: "auto",
        }}
      >
        {"POST /api/chat\nAuthorization: Bearer <APP_API_KEY>\nContent-Type: application/json\n\n{ \"prompt\": \"Hello!\" }"}
      </pre>
      <p>See README.md for setup and full request/response details.</p>
    </main>
  );
}
