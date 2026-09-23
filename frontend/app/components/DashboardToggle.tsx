import React, { useState } from "react";
import AccessToken from "./AccessToken";
import ProjectManager from "./ProjectManager";

const DashboardToggle = () => {
  const [isVisible, setIsVisible] = useState(false);

  const toggleDashboard = () => {
    setIsVisible(!isVisible);
  };

  return (
    <div style={{ background: "#F8F9FA", padding: "20px", borderRadius: "8px" }}>
      <button
        onClick={toggleDashboard}
        style={{
          backgroundColor: "rgb(204, 229, 254)",
          color: "rgb(0, 102, 204)",
          border: "none",
          borderRadius: "8px",
          padding: "10px 20px",
          cursor: "pointer",
          fontWeight: "bold",
          marginBottom: "20px",
          transition: "background-color 0.3s ease",
        }}
        onMouseOver={(e) => (e.currentTarget.style.backgroundColor = "rgb(180, 210, 240)")}
        onMouseOut={(e) => (e.currentTarget.style.backgroundColor = "rgb(204, 229, 254)")}
      >
        {isVisible ? "Hide Dashboard" : "Show Dashboard"}
      </button>

      {isVisible && (
        <div
          style={{
            animation: "fadeIn 0.5s ease-in-out",
            opacity: isVisible ? 1 : 0,
          }}
        >
          <AccessToken />
          <ProjectManager />
        </div>
      )}
    </div>
  );
};

export default DashboardToggle;
