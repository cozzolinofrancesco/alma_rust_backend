import React from "react";

interface FootnotesProps {
  notes: string[];
}

interface LinkItem {
  text: string;
  url: string;
  description?: string;
}

interface Category {
  title: string;
  items: LinkItem[];
}

const Footnotes: React.FC<FootnotesProps> = ({ notes }) => {
  console.log("Received notes:", notes);

  // Support contact is configured via env — no personal email hardcoded in source.
  const supportEmail = process.env.NEXT_PUBLIC_SUPPORT_EMAIL ?? "";

  const categories: Category[] = [
    {
      title: "Team",
      items: [
        { text: "About", url: "https://sites.google.com/roche.com/alma/home", description: "Learn more about us" },
        { text: "Careers", url: "", description: "Join our team" },
        { text: "Use cases", url: "", description: "See our solutions" },
        ...(supportEmail
          ? [{ text: "Contact Support 24/7", url: `mailto:${supportEmail}`, description: supportEmail }]
          : []),
        { text: "Bugs", url: "https://forms.gle/hojeY8kRjqoae2pPA", description: "Report a bug" },
      ],
    },
    {
      title: "Legal",
      items: [
        { text: "Privacy", url: "", description: "Our privacy policy" },
        { text: "Disclaimers", url: "", description: "Terms of service" },
      ],
    },
  ];

  return (
    <div style={styles.container}>
      <div style={styles.categoriesRow}>
        {categories.map((cat, idx) => (
          <div key={idx} style={styles.categoryColumn}>
            <h4 style={styles.categoryTitle}>{cat.title}</h4>
            {cat.items.map((item, itemIndex) => (
              <div key={itemIndex} style={styles.itemContainer}>
                <a 
                  href={item.url} 
                  style={styles.link}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {item.text}
                </a>
                {item.description && (
                  <p style={styles.description}>{item.description}</p>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>
      <div style={styles.copyRow}>
        Code Licensed under Apache 2.0 License <br />
        {new Date().getFullYear()}
      </div>
    </div>
  );
};

const styles: { [key: string]: React.CSSProperties } = {
  container: {
    borderTop: "1px solid #e0e0e0",
    backgroundColor: "#f9f9f9",
    padding: "2rem",
    fontSize: "0.85rem",
    color: "#444",
    fontFamily: "'Helvetica Neue', Helvetica, Arial, sans-serif",
  },
  categoriesRow: {
    display: "flex",
    justifyContent: "space-around",
    marginBottom: "1.5rem",
  },
  categoryColumn: {
    display: "flex",
    flexDirection: "column",
    minWidth: "150px",
    alignItems: "center",
  },
  categoryTitle: {
    fontSize: "1rem",
    fontWeight: "bold",
    marginBottom: "0.75rem",
    color: "#444",
  },
  itemContainer: {
    marginBottom: "0.5rem",
    textAlign: "center",
  },
  link: {
    textDecoration: "none",
    color: "#444",
    fontWeight: "500",
  },
  description: {
    margin: "0.25rem 0 0 0",
    fontSize: "0.75rem",
    color: "#666",
  },
  copyRow: {
    textAlign: "center",
    color: "#888",
  },
};

export default Footnotes;
