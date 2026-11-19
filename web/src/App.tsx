import { useEffect, useState, createContext, useContext, ReactNode } from "react";
import { loadMailbox, saveMailbox, clearMailbox, type Mailbox } from "./lib/mailbox.js";
import { loadAdminSession, clearAdminSession, type AdminSession } from "./lib/adminApi.js";
import { Inbox } from "./pages/Inbox.js";
import { Read } from "./pages/Read.js";
import { Compose } from "./pages/Compose.js";
import { Settings } from "./pages/Settings.js";
import { AdminLogin } from "./pages/admin/Login.js";
import { AdminDashboard } from "./pages/admin/Dashboard.js";

type Page = "inbox" | "read" | "compose" | "settings" | "admin" | "adminLogin";

interface AppContextValue {
  mailbox: Mailbox | null;
  setMailbox: (m: Mailbox | null) => void;
  page: Page;
  setPage: (p: Page) => void;
  messageId: string | null;
  setMessageId: (id: string | null) => void;
  adminSession: AdminSession | null;
  setAdminSession: (s: AdminSession | null) => void;
}

const AppContext = createContext<AppContextValue | null>(null);
export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp outside AppProvider");
  return ctx;
}

function AppProvider({ children }: { children: ReactNode }) {
  const [mailbox, setMailboxState] = useState<Mailbox | null>(null);
  const [page, setPage] = useState<Page>("inbox");
  const [messageId, setMessageId] = useState<string | null>(null);
  const [adminSession, setAdminSession] = useState<AdminSession | null>(null);

  function setMailbox(m: Mailbox | null) {
    setMailboxState(m);
    if (m) saveMailbox(m);
    else clearMailbox();
    setPage(m ? "inbox" : "settings");
  }

  function setAdminSessionAndPage(s: AdminSession | null) {
    setAdminSession(s);
    if (s) {
      setPage("admin");
    } else {
      setPage("inbox");
    }
  }

  useEffect(() => {
    setMailboxState(loadMailbox());
  }, []);

  useEffect(() => {
    setAdminSession(loadAdminSession());
  }, []);

  return (
    <AppContext.Provider
      value={{
        mailbox,
        setMailbox,
        page,
        setPage,
        messageId,
        setMessageId,
        adminSession,
        setAdminSession: setAdminSessionAndPage,
      }}
    >
      {children}
    </AppContext.Provider>
  );
}

function isAdminPath(): boolean {
  return window.location.pathname.replace(/\/+$/, "") === "/admin";
}

function Layout({ children }: { children: ReactNode }) {
  const { mailbox, setPage, adminSession, setAdminSession } = useApp();
  if (!mailbox) return <Settings onSubmit={() => setPage("inbox")} />;

  return (
    <div style={styles.layout}>
      <header style={styles.header}>
        <h1 style={styles.title}>Webmail</h1>
        <nav style={styles.nav}>
          <button onClick={() => setPage("inbox")} style={styles.navLink}>Inbox</button>
          <button onClick={() => setPage("compose")} style={styles.navLink}>Compose</button>
          <button onClick={() => setPage("settings")} style={styles.navLink}>Settings</button>
          <a
            href="/admin"
            style={{ ...styles.navLink, textDecoration: "none", display: "inline-block" }}
            onClick={() => {
              if (!adminSession) setAdminSession(null);
            }}
          >
            Admin
          </a>
        </nav>
      </header>
      <main style={styles.main}>{children}</main>
    </div>
  );
}

function Router() {
  const { page, messageId } = useApp();
  switch (page) {
    case "inbox":
      return <Inbox />;
    case "read":
      return messageId ? <Read messageId={messageId} /> : <Inbox />;
    case "compose":
      return <Compose />;
    case "settings":
      return <Settings onSubmit={() => {}} />;
  }
}

function AdminRouter() {
  const { adminSession } = useApp();
  if (!adminSession) return <AdminLogin />;
  return <AdminDashboard />;
}

export default function App() {
  const admin = isAdminPath();
  return (
    <AppProvider>
      {admin ? <AdminRouter /> : (
        <Layout>
          <Router />
        </Layout>
      )}
    </AppProvider>
  );
}

const styles: Record<string, React.CSSProperties> = {
  layout: { minHeight: "100vh", display: "flex", flexDirection: "column", fontFamily: "system-ui, sans-serif" },
  header: { padding: "1rem", borderBottom: "1px solid #e5e7eb", display: "flex", justifyContent: "space-between", alignItems: "center" },
  title: { margin: 0, fontSize: "1.25rem" },
  nav: { display: "flex", gap: "0.5rem" },
  navLink: { padding: "0.4rem 0.75rem", border: "1px solid #e5e7eb", borderRadius: "0.25rem", background: "white", cursor: "pointer" },
  main: { flex: 1, padding: "1rem", maxWidth: "800px", margin: "0 auto", width: "100%" },
};