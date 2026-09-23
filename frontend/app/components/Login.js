// src/app/components/Login.js

"use client";

import { signIn, signOut, useSession } from "next-auth/react";

export default function Login() {
  const { data: session } = useSession();

  return (
    <div style={{ margin: "20px" }}>
      {session ? (
        <div>
          <p>Welcome, {session.user?.name}!</p>
          <button onClick={() => signOut()}>Logout</button>
        </div>
      ) : (
        <button onClick={() => signIn()}>Login with Google</button>
      )}
    </div>
  );
}
