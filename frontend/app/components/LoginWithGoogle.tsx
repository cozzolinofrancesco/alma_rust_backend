"use client";

import { signIn, signOut, useSession } from "next-auth/react";
import { useEffect } from "react";

const LoginWithGoogle: React.FC = () => {
  const { data: session } = useSession();

  useEffect(() => {
  }, [session]);

  const loginInfoStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: "0.75rem", 
  };

  const userNameStyle: React.CSSProperties = {
    fontSize: "1rem",
    color: "#333",
  };

  const buttonStyle: React.CSSProperties = {
    backgroundColor: "#0F084B",
    color: "#fff",
    border: "none",
    padding: "0.5rem 1rem",
    borderRadius: "4px",
    cursor: "pointer",
    transition: "background-color 0.3s ease",
  };

  const handleMouseOver = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.currentTarget.style.backgroundColor = "#0F084B";
  };

  const handleMouseOut = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.currentTarget.style.backgroundColor = "#0F084B";
  };

  if (session) {
    const fullName = session.user?.name || session.user?.email;
    const nameParts = fullName ? fullName.split(" ") : [];
    const firstName = nameParts[0] || "";
    const lastName = nameParts.slice(1).join(" ") || "";
    return (
      <div style={loginInfoStyle}>
        <span style={userNameStyle}>
          {firstName} {lastName} 
        </span>
        <button
          style={buttonStyle}
          onClick={() => signOut()}
          onMouseOver={handleMouseOver}
          onMouseOut={handleMouseOut}
        >
          Sign out
        </button>
      </div>
    );
  }

  return (
    <button
      style={buttonStyle}
      onClick={() => signIn("google")}
      onMouseOver={handleMouseOver}
      onMouseOut={handleMouseOut}
    >
      Sign in with Google
    </button>
  );
};

export default LoginWithGoogle;
