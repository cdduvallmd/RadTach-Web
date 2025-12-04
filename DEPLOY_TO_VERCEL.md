# Deploying RadTach to Vercel

## Quick Deploy (Recommended)

### Option 1: Deploy via GitHub (Easiest)

1. **Create a GitHub repository:**
   ```bash
   # Go to https://github.com/new
   # Create a new repository named "radtach-web"
   # Don't initialize with README (we already have one)
   ```

2. **Push your code to GitHub:**
   ```bash
   git remote add origin https://github.com/YOUR_USERNAME/radtach-web.git
   git branch -M main
   git push -u origin main
   ```

3. **Deploy to Vercel:**
   - Go to [vercel.com](https://vercel.com)
   - Click "New Project"
   - Import your GitHub repository
   - Vercel will auto-detect Vite settings
   - Click "Deploy"
   - Done! Your app will be live at `https://radtach-web.vercel.app`

### Option 2: Deploy via Vercel CLI

1. **Install Vercel CLI:**
   ```bash
   npm install -g vercel
   ```

2. **Login to Vercel:**
   ```bash
   vercel login
   ```

3. **Deploy:**
   ```bash
   vercel
   ```

4. **Follow the prompts:**
   - Set up and deploy? **Yes**
   - Which scope? **Your account**
   - Link to existing project? **No**
   - Project name? **radtach-web** (or your preferred name)
   - Directory? **./** (current directory)
   - Override settings? **No**

5. **Deploy to production:**
   ```bash
   vercel --prod
   ```

## Project Configuration

Vercel will automatically detect these settings:

- **Framework:** Vite
- **Build Command:** `npm run build`
- **Output Directory:** `dist`
- **Install Command:** `npm install`

## Custom Domain (Optional)

1. Go to your project on Vercel
2. Click "Settings" → "Domains"
3. Add your custom domain (e.g., `radtach.com`)
4. Follow DNS configuration instructions
5. Wait for DNS propagation (5-60 minutes)

## Environment Variables

RadTach doesn't require any environment variables for basic operation. All settings are stored in the browser's localStorage.

If you add backend features in the future, you can add environment variables in:
- Vercel Dashboard → Your Project → Settings → Environment Variables

## Automatic Deployments

Once connected to GitHub:
- **Every push to `main`** triggers a production deployment
- **Every pull request** gets a preview deployment
- **Preview URLs** are automatically generated

## Build Settings

The project is configured with:

```json
{
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview"
  }
}
```

Vercel will run:
1. `npm install` - Install dependencies
2. `npm run build` - Build the project (TypeScript compilation + Vite build)
3. Deploy the `dist` folder

## Testing Your Deployment

After deployment:

1. **Check the deployment URL** (e.g., `https://radtach-web.vercel.app`)
2. **Test core features:**
   - Select a modality
   - Start timer (click Par Time)
   - Complete study (click Elapsed Time)
   - Open Settings - verify localStorage persistence
   - Test CSV export/import

## Troubleshooting

### Build Fails

**Error:** `Could not resolve dependency`
```bash
# Locally, clear and reinstall
rm -rf node_modules package-lock.json
npm install
npm run build
```

If it works locally, Vercel should work too. Check Vercel build logs for specific errors.

### Tailwind Styles Not Working

Make sure all these files exist:
- `tailwind.config.js`
- `postcss.config.js`
- `src/index.css` with `@tailwind` directives

### TypeScript Errors

Run locally first:
```bash
npm run build
```

Fix any TypeScript errors before deploying.

## Performance Optimization

Vercel automatically provides:
- ✅ Global CDN
- ✅ Automatic compression (gzip/brotli)
- ✅ HTTP/2 and HTTP/3 support
- ✅ Smart caching
- ✅ Automatic image optimization (if you add images later)

## Monitoring

View your deployment stats:
- Vercel Dashboard → Your Project → Analytics
- See visitor count, performance metrics, and errors

## Updating Your Deployment

### Via GitHub:
```bash
git add .
git commit -m "Your update message"
git push
```
Vercel auto-deploys the changes.

### Via CLI:
```bash
vercel --prod
```

## Rollback

If a deployment has issues:
1. Go to Vercel Dashboard → Your Project → Deployments
2. Find a previous working deployment
3. Click "..." → "Promote to Production"

## Cost

**Vercel Free Tier includes:**
- ✅ Unlimited deployments
- ✅ Automatic HTTPS
- ✅ 100 GB bandwidth/month
- ✅ Unlimited team members
- ✅ Preview deployments

**Perfect for RadTach!** You won't need a paid plan unless:
- You get >100GB traffic/month
- You need advanced analytics
- You need team collaboration features

## Security

Vercel provides:
- ✅ Automatic HTTPS/SSL
- ✅ DDoS protection
- ✅ Firewall
- ✅ Edge caching

**No PHI is stored on the server** - all RadTach data is in the user's browser localStorage.

## Useful Commands

```bash
# Check deployment status
vercel ls

# View logs
vercel logs

# Open project in browser
vercel open

# Remove a project
vercel remove radtach-web
```

## Support

- **Vercel Docs:** https://vercel.com/docs
- **Vercel Community:** https://github.com/vercel/vercel/discussions
- **RadTach Issues:** Contact Charles Darren Duvall, MD at cdduvallmd@yahoo.com

---

**Your RadTach app is ready to deploy! 🚀**

Once deployed, share the URL with colleagues and start tracking productivity!
