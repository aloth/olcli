#!/usr/bin/env node
import readline from 'node:readline';

// Git passes the remote name and URL as arguments:
// e.g., process.argv = ['node', 'git-remote-overleaf', 'origin', 'overleaf::123456']
const remoteName = process.argv[2];
const url = process.argv[3];
const projectId = url.split('::')[1]; // Extracts "123456"

const rl = readline.createInterface({
	input: process.stdin,
	output: process.stdout,
	terminal: false,
});

rl.on('line', async line => {
	if (line === 'capabilities') {
		console.log('fetch');
		console.log('push');
		console.log(''); // Empty line means end of response
	} else if (line === 'list') {
		// Return a dummy hash for now, representing the current Overleaf state
		console.log('0000000000000000000000000000000000000000 refs/heads/master');
		console.log('@refs/heads/master HEAD');
		console.log('');
	} else if (line.startsWith('fetch')) {
		// 1. Download the Overleaf ZIP using olcli's API client
		// 2. Unzip it into a temporary folder
		// 3. Feed the files into Git
		console.log('');
	} else if (line.startsWith('push')) {
		// 1. Read the local Git files
		// 2. Upload them to Overleaf using your olcli push logic
		console.log('ok refs/heads/master'); // Tell Git it succeeded
		console.log('');
	} else if (line === '') {
		// Empty line from Git means "I'm done, you can exit"
		process.exit(0);
	}
});
