# Lesson request

## Goal
Prepare the student step-by-step for the final BIO problem (Problem 3), with quizzes that teach theory via info cards and practice via mixed MCQ and short free-text questions. Keep official examples visible in the problem description and use hidden test cases for marking.

## Plan preferences
- Total plan items: 7
- 1. quiz - Quiz 1: Foundations for Problem 1 (18 questions; mix: info-card: 4, multiple-choice: 10, type-answer: 4)
- 2. coding_problem - Problem 1: Intro BIO-Style Task
- 3. quiz - Quiz 2: Concepts for Problem 2 (18 questions; mix: info-card: 4, multiple-choice: 10, type-answer: 4)
- 4. coding_problem - Problem 2: Intermediate BIO-Style Task
- 5. quiz - Quiz 3: Final Prep for BIO Problem (18 questions; mix: info-card: 4, multiple-choice: 10, type-answer: 4)
- 6. coding_problem - Problem 3: Final BIO Problem
- 7. quiz - Quiz 4: Review and Reflection (18 questions; mix: info-card: 4, multiple-choice: 10, type-answer: 4)

Notes:
- Lesson duration is inferred from plan items + question counts (no fixed minutes).

## OFFICIAL PROBLEM (verbatim)
Question 2: Safe Haven

Red and Green are playing a game on an square grid, trying to create as many safe havens of their own
colour as possible. Each square on the grid is either empty or is controlled by Red or Green. Squares are
neighbours if they touch on an edge; i.e. immediately horizontally or vertically adjacent. A haven is a
group of non-empty squares where it is possible to go between any two squares in the haven by a
sequence of neighbours in the haven, and no other non-empty square in the game neighbours a square in
the haven. A safe haven is a haven that only contains squares of a single colour.

The top row squares on the grid have positions 1 to n (from left to right), the next row positions n+1 to 2n
(left to right), etc. so that the bottom right square is position n2.

Before the game begins, the grid is set up by marking all squares as empty and then having players
alternate taking control of empty squares, until all are controlled. Red starts by taking control of 1 and
then repeatedly for their turn, starting with Green:
- A player will visit successive positions on the grid. If they reach n2 they will next visit 1.
- They start at the position immediately after the most recently controlled square.
- A player keeps track of the number of times they visit an empty square. When this reaches a fixed
  modifier (r for Red and g for Green) they take control of the square and their turn ends.

For example, suppose they are playing on a 3x3 grid and that both r and g are 5.
- Red controls 1;
- Green visits empty squares at 2, 3, 4, 5, 6 and takes control of 6;
- Red visits empty squares at 7, 8, 9, then 1 (which is non-empty), then empty squares 2, 3 and takes
  control of 3;
- Green controls 9. Red controls 8;
- Green will visit 9, 1, 2, 3, 4, 5, 6, 7, 8, 9, 1, 2 and controls 2. As there were only 4 empty squares
  at the start of their turn, it was necessary to visit one of the empty squares more than once;
- When the set up is complete Red controls 1, 3, 4, 5 and 8. Green controls the other squares.

The game now begins. A move involves two neighbouring squares which are controlled by different
players. The current player will transfer their control to the neighbouring square; i.e. their currently
controlled square will become empty and the neighbouring square switches to their control.

On their turn players will use the following strategy to determine their move:
- The player selects the non-safe haven containing the smallest number of squares controlled by their
  opponent. In the event of a tie, they select the haven containing the largest number of squares that
  they control. If there is still a tie, they select the one containing the square with highest value position.
- The player selects the lowest value position in this haven that they control and which neighbours a
  square controlled by their opponent.
- The player’s move is a transfer involving this square and the lowest value neighbouring square
  controlled by their opponent.

When resolving a tie, only the tied havens are considered. Other havens on the grid are ignored.

For example, suppose there are havens with 1 Red and 0 Green, 2 Red and 3 Green, 4 Red and 3 Green
and 9 Red and 4 Green. It is Red’s turn:
- They will not select the haven with 1 Red and 0 Green, as this is a safe haven;
- The smallest number of Green squares in a haven is 3 but there is tie;
- The largest number of Red squares in one of the havens with 3 Green squares is 4. This haven will
  be selected.

Starting with Red, turns alternate until there are no more valid moves which can be taken. At the end of
the game all controlled squares will be in safe havens and each player counts the number of safe havens
that they control.

2(a) [ 25 marks ]
Write a program that plays haven.

Your program should input a line containing three integers, n (1 <= n <= 10) then
r (1 <= r <= 5000) then g (1 <= g <= 5000), indicating the size of the grid and the modifiers
for Red and Green respectively.

You should output two integers, the number of safe havens controlled by Red
followed by the number controlled by Green at the end of the game.

Sample run
3 5 5
2 1

## MARKING (verbatim)
[1] 3 5 5 2 1
[2] 1 100 200 1 0
[2] 2 1 1 1 1
[2] 2 7 23 1 0
[2] 4 8 94 3 3
[2] 6 213 1040 3 6
[2] 7 2025 7 7 6
[3] 8 19 22 4 10
[3] 9 510 4152 9 5
[3] 10 3548 872 9 15
[3] 10 4999 4999 5 8

## Notes
- Use official sample run(s) in visible examples.
- Use marking rows beyond the sample as hidden tests for assessment.
- Do not use Darwinian terminology.
