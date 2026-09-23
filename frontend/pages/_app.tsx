import { AppProps } from "next/app";
import Head from "next/head";
import Navbar from "@/app/components/Navbar";
import { MathJaxContext } from "better-react-mathjax";
import { RootProvider } from "@/app/components/RootProvider";

function MyApp({ Component, pageProps }: AppProps) {
  return (
    <>
      <Head>
        <title>Alma</title>
        <link rel="icon" href="/images/favicon.png" type="image/png" />
        <link
          href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css"
          rel="stylesheet"
          integrity="sha384-9ndCyUaBvJ1Anm2K9IACs2eqOnkEGgPeWsy2zV+o0FIQN2ZKk4pBBnR8ZkOrMbF1"
          crossOrigin="anonymous"
        />
      </Head>
      <RootProvider>
        <MathJaxContext 
          config={{
            loader: { load: ['[tex]/html'] },
            tex: {
              inlineMath: [['$', '$']],
              displayMath: [['$$', '$$']],
            },
          }}
          src="https://cdn.jsdelivr.net/npm/mathjax@3.2.2/es5/tex-mml-chtml.js"
          onError={(error) => {
            console.error('❌ MathJax failed to load from jsDelivr CDN:', error);
            console.log('🔄 Consider using fallback CDN or self-hosting MathJax');
          }}
        >
          <Navbar />
          <Component {...pageProps} />
        </MathJaxContext>
      </RootProvider>
    </>
  );
}

export default MyApp;
