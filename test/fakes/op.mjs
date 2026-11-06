#!/usr/bin/env node
// A stand-in 1Password CLI for fill's tests: two logins for example.com, one
// with a one-time code, and one for another site.
const args = process.argv.slice(2).join(' ');
const items = [
  { id: 'aaa', title: 'Example work', vault: { name: 'Private' }, urls: [{ href: 'https://example.com/login' }] },
  { id: 'bbb', title: 'Example personal', vault: { name: 'Private' }, urls: [{ href: 'https://www.example.com' }] },
  { id: 'ccc', title: 'Other', vault: { name: 'Private' }, urls: [{ href: 'https://other.test' }] },
];
if (args.startsWith('item list')) console.log(JSON.stringify(items));
else if (/^item get (\w+) --otp/.test(args)) console.log('123456');
else if (/^item get (\w+)/.test(args)) {
  const id = args.split(' ')[2];
  const fields = [
    { id: 'username', purpose: 'USERNAME', value: `user-${id}@example.com` },
    { id: 'password', purpose: 'PASSWORD', value: `pw-${id}-secret` },
  ];
  if (id === 'aaa') fields.push({ id: 'one-time', type: 'OTP', value: 'otpauth://totp/x?secret=ABC' });
  console.log(JSON.stringify({ id, fields }));
} else {
  console.error('[ERROR] unknown command');
  process.exit(1);
}
