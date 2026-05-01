const loginForm  = document.getElementById('login-form');
const loginError = document.getElementById('login-error');

loginForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    loginError.textContent = '';

    const username = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value.trim();

    if (!username || !password) {
        loginError.textContent = 'Please enter username and password.';
        return;
    }

    try {
        // credentials:'include' required so session cookie is set on HTTPS
        const res = await fetch('/login', {
            method:      'POST',
            credentials: 'include',
            headers:     { 'Content-Type': 'application/json' },
            body:        JSON.stringify({ username, password }),
        });

        if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            throw new Error(body.error || 'Login failed');
        }

        window.location.href = '/ui';
    } catch (err) {
        loginError.textContent = err.message;
    }
});
