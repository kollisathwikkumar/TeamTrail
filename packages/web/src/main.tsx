import React from 'react';
import { createRoot } from 'react-dom/client';
import { Auth0Provider } from '@auth0/auth0-react';
import App from './App';
import './styles.css';

const domain = import.meta.env.VITE_AUTH0_DOMAIN;
const clientId = import.meta.env.VITE_AUTH0_CLIENT_ID;
const audience = import.meta.env.VITE_AUTH0_AUDIENCE;
const app = <React.StrictMode><App /></React.StrictMode>;

createRoot(document.getElementById('root')!).render(
  domain && clientId && audience ? <Auth0Provider
    domain={domain}
    clientId={clientId}
    cacheLocation="memory"
    useRefreshTokens
    authorizationParams={{ redirect_uri: window.location.origin, audience, scope: 'openid profile email mcp:read mcp:write' }}
  >{app}</Auth0Provider> : app,
);
