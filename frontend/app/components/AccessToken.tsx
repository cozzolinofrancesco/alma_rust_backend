'use client';

import React, { useState } from 'react';
import { useProjectState } from './ProjectStateContext';

const AccessTokenComponent: React.FC = () => {
  const [inputRefreshToken, setInputRefreshToken] = useState('');

  const { setToken } = useProjectState();

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setInputRefreshToken(e.target.value);
  };

  const handleAddToken = async () => {
    try {
      const response = await fetch('/api/auth/refresh-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: inputRefreshToken }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to refresh token: ${errorText}`);
      }

      const data = await response.json();
      
      setToken(data.accessToken);

    } catch (error: unknown) {
      if (error instanceof Error) {
        console.error('Error refreshing token:', error.message);
      } else {
        console.error('Error refreshing token:', error);
      }
    }
  };

  return (
    <div style={{ marginLeft: "30px" }}>
    <label htmlFor="refresh-token"></label>
    <input
      id="refresh-token"
      type="text"
      placeholder="Enter your refresh token"
      value={inputRefreshToken}
      onChange={handleInputChange}
      style={{
        width: "30%",
        padding: "8px",
        margin: "8px 0",
        borderRadius: "4px",
        border: "1px solid #ccc",
      }}
    />
    <button
      onClick={handleAddToken}
      style={{
        backgroundColor: "rgb(204, 229, 254)",
        color: "rgb(0, 102, 204)",
        border: "none",
        borderRadius: "8px",
        padding: "10px 20px",
        margin: "8px 0 8px 10px",
        cursor: "pointer",
        fontWeight: "bold",
      }}
    >
      Add Token
    </button>
    {}
  </div>
  );
};

export default AccessTokenComponent;
