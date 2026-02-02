# olcli Demo GIF
Output demo.gif

Set Shell "zsh"
Set FontSize 18
Set Width 800
Set Height 500
Set Theme "Dracula"
Set Padding 20

# Pull an Overleaf project
Type "olcli pull 'My Paper'"
Enter
Sleep 3s

Type "cd My_Paper"
Enter
Sleep 500ms

Type "ls"
Enter
Sleep 1s

# Sync changes back to Overleaf
Type "olcli sync"
Enter
Sleep 3s

# Download the PDF
Type "olcli pdf"
Enter
Sleep 4s
