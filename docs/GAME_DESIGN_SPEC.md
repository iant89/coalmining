# Forge-Engine Coal Mine Simulator — Game Design & Technical Specification

> Document Version 1.0 · Engine: Forge-Engine (github.com/iant89/Forge-Engine) · Genre: Industrial
> Simulation / Management / Strategy · Perspective: 3D Isometric / Free Camera · Primary Platform:
> Desktop · Simulation: Real-Time with Pause and Adjustable Speed
>
> This is the design brief the game is built against (long vertical lists are condensed onto
> lines; the content is unchanged). Implementation status is tracked in
> [ROADMAP.md](ROADMAP.md); deliberate deviations are noted in [ARCHITECTURE.md](ARCHITECTURE.md)
> (notably the 5-second simulation tick instead of the suggested one-minute tick, §5).

```
================================================================================
0. DOCUMENT PURPOSE
================================================================================

This document defines the technical and gameplay architecture for a realistic
surface coal mining simulation built on top of Forge-Engine.

The game should simulate the operation of a small-to-large surface coal mine
while simplifying highly technical real-world processes enough to remain
playable.

The player inherits a small family-owned coal mine from their grandfather.

The player must:

    - Acquire land and mineral rights
    - Obtain and maintain permits
    - Explore the geology
    - Plan mining areas
    - Drill blast holes
    - Prepare and execute blasts
    - Remove overburden
    - Expose and mine coal
    - Haul material
    - Build conveyor systems
    - Process coal
    - Sell coal
    - Hire and manage workers
    - Purchase and upgrade equipment
    - Maintain equipment
    - Manage safety
    - Pass regulatory inspections
    - Pay fines and correct violations
    - Reclaim mined land
    - Expand the mine
    - Manage debt and profitability

The core design principle is:

    THE PLAYER MANAGES A LIVING MINING OPERATION.

The player should not merely place buildings and watch numbers increase.

Equipment, workers, terrain, geology, logistics, safety, regulation, finances,
and production must interact with one another.

================================================================================
1. DESIGN PHILOSOPHY
================================================================================

1.1 REALISM

The game should strive for believable mining operations.

It does NOT need to reproduce every real-world engineering calculation.

Instead:

    REALISTIC SYSTEMS
        +
    SIMPLIFIED PLAYER INTERACTION
        =
    ACCESSIBLE INDUSTRIAL SIMULATION

The player should understand:

    "Why did this happen?"

without needing to understand:

    "How do I calculate this manually?"

-------------------------------------------------------------------------------

1.2 EMERGENT GAMEPLAY

Events should preferably emerge from simulation state.

Example:

    OLD TRUCK
        +
    POOR MAINTENANCE
        +
    FATIGUED OPERATOR
        +
    WET HAUL ROAD
        =
    HIGH ACCIDENT RISK

rather than:

    RANDOM EVENT:
        "Truck accident"

-------------------------------------------------------------------------------

1.3 SYSTEM INTERDEPENDENCE

Major systems must influence one another.

    GEOLOGY -> MINING PLAN -> EQUIPMENT REQUIREMENTS -> WORKFORCE -> PRODUCTION
      -> LOGISTICS -> COAL QUALITY -> REVENUE -> EXPANSION -> ENVIRONMENT / RECLAMATION

    SAFETY -> INSPECTIONS -> VIOLATIONS -> FINES / SHUTDOWNS -> FINANCIAL PERFORMANCE


================================================================================
2. FORGE-ENGINE ARCHITECTURE
================================================================================

The coal mining game MUST remain a game/application layer above Forge-Engine.

DO NOT implement coal-mining-specific logic inside Forge-Engine core.

Recommended architecture:

    Forge-Engine/
    |
    +-- Core (Application, Entity, Component, Systems, Events, Time, Serialization)
    +-- Rendering, Scene, Camera, Input, Physics, Audio, Animation, Terrain, UI,
        Navigation, Debug
    |
    v
    CoalMineGame/
    |
    +-- World, Mining, Equipment, Workforce, Logistics, Processing, Regulatory,
        Economy, Environment, Story, SaveGame, UI, Scenarios

The game should consume Forge-Engine APIs rather than modifying engine internals
unless a missing engine capability is genuinely required.

================================================================================
3. GAME DOMAIN MODULES
================================================================================

CoalMineGame
+-- World        MineWorld, Terrain, GeologicalModel, Parcels, Roads, Water, Weather
+-- Mining       Exploration, Drilling, Blasting, Overburden, CoalExtraction, Reclamation
+-- Equipment    EquipmentRegistry, EquipmentController, EquipmentMaintenance,
|                EquipmentUpgrades, EquipmentAI
+-- Workforce    EmployeeRegistry, Skills, Certifications, Training, Fatigue
+-- Logistics    Tasks, Dispatch, HaulRoads, Conveyors, Stockpiles, MaterialRouting
+-- Processing   Crusher, Screens, Separators, PreparationPlant, Loadout
+-- Regulatory   Permits, Inspections, Violations, Compliance
+-- Economy      Treasury, Payroll, Contracts, Market, Loans, Royalties
+-- Environment  Water, Dust, Reclamation, Disturbance
+-- Story        Campaign, Characters, Events
+-- SaveGame
+-- UI

================================================================================
4. CORE FORGE-ENGINE GAME OBJECT MODEL
================================================================================

The game should distinguish between ENGINE ENTITIES and GAME DOMAIN OBJECTS.

A rendered truck is an Engine Entity. The mining simulation state belongs to a
domain object/component associated with that entity.

    Forge Entity
        +-- Transform
        +-- Renderable
        +-- PhysicsBody
        +-- EquipmentComponent
        +-- VehicleMovementComponent
        +-- OperatorComponent
        +-- MaintenanceComponent

The EquipmentComponent references the mining-domain equipment definition.

4.1 ENTITY CATEGORIES

World entities: TerrainChunk, Road, WaterBody, Building, ParcelMarker,
CoalSeamVisualization, Stockpile, Conveyor, MiningBench

Equipment entities: Excavator, Dozer, Drill, HaulTruck, Loader, WaterTruck,
ServiceTruck, Grader, Crusher, ConveyorDrive, PlantEquipment

People: Employee, Inspector, LandOwner, Customer, Contractor

Infrastructure: MineOffice, MaintenanceShop, FuelStation, PreparationPlant,
PowerSubstation, SedimentPond, Loadout

================================================================================
5. SIMULATION TIME
================================================================================

The simulation operates on a configurable game clock.

Suggested modes: PAUSED, 1x, 2x, 5x, 10x, 25x, 50x

Recommended internal simulation tick: 1 simulated minute

Rendering remains frame-rate driven. The simulation should NOT depend directly
on render FPS.

5.1 SIMULATION PIPELINE

Every simulation tick:

    01. Advance simulation clock
    02. Update weather
    03. Update terrain/environment
    04. Update workers
    05. Update equipment
    06. Process tasks
    07. Process mining
    08. Process logistics
    09. Process conveyors
    10. Process preparation plant
    11. Update stockpiles
    12. Update safety conditions
    13. Evaluate regulatory conditions
    14. Update economy
    15. Process contracts
    16. Process random/event system
    17. Generate notifications
    18. Update statistics

================================================================================
6. TASK SYSTEM
================================================================================

THE TASK SYSTEM IS THE CENTRAL GAMEPLAY SYSTEM.

Almost every physical operation should be represented as a Task.

Examples: MOVE, DRILL, BLAST, EXCAVATE, LOAD, HAUL, DUMP, MINE_COAL, CRUSH,
PROCESS, CONVEY, FUEL, MAINTENANCE, REPAIR, INSPECT, PARK, RECLAIM, GRADE,
WATER_ROAD

6.1 TASK MODEL

Task: id, type, status, priority, source, destination, requiredEquipmentType,
assignedEquipment, requiredWorkerRole, assignedWorker, prerequisites, createdAt,
startedAt, completedAt, estimatedDuration, progress, materialType,
materialAmount, failureReason

6.2 TASK STATES

    CREATED -> VALIDATING -> QUEUED -> ASSIGNED -> TRAVELING -> EXECUTING
    EXECUTING -> BLOCKED -> RESOLVING -> EXECUTING
    EXECUTING -> COMPLETED

Alternative terminal states: CANCELLED, FAILED

6.3 TASK VALIDATION

Before execution:

    Is equipment available?
    Is equipment operational?
    Is worker available?
    Is worker qualified?
    Is destination accessible?
    Is source available?
    Is permit valid?
    Is task allowed by current mine plan?
    Is required infrastructure operational?
    Is weather acceptable?
    Is safety status acceptable?

If any requirement fails: TASK = BLOCKED. The player should receive an
explanation. Example:

    TASK BLOCKED
    CAT 777 #04 cannot haul coal.
    Reason: Assigned operator lacks required qualification.

6.4 TASK DEPENDENCIES

Tasks may depend on other tasks: DRILL -> BLAST -> EXCAVATE -> LOAD -> HAUL -> DUMP

================================================================================
7. EQUIPMENT SYSTEM
================================================================================

Every machine is represented by: EquipmentDefinition, EquipmentInstance,
EquipmentComponent, EquipmentController

7.1 EQUIPMENT DEFINITION — static specifications: manufacturer, model, category,
purchasePrice, horsepower, payload, fuelCapacity, fuelConsumption, maximumSpeed,
operatingCost, maintenanceInterval, expectedLifetime, requiredWorkerRole,
requiredCertification, availableUpgrades

7.2 EQUIPMENT INSTANCE — runtime state: id, equipmentDefinition, condition,
operatingHours, fuel, wear, currentTask, currentOperator, location,
maintenanceState, breakdownState, upgrades

7.3 EQUIPMENT STATE MACHINE: PARKED, AVAILABLE, ASSIGNED, TRAVELING, LOADING,
HAULING, UNLOADING, WORKING, FUELING, MAINTENANCE, BROKEN, DISABLED

7.4 INITIAL EQUIPMENT

Tier 1: Bulldozer, Excavator, Blast Drill, Haul Truck, Wheel Loader, Water Truck,
Grader, Service Truck

Later: Larger Excavators, Electric Rope Shovels, Draglines, Larger Haul Trucks,
Highwall Miner, Surface Miner, Autonomous Haul Trucks

================================================================================
8. EQUIPMENT UPGRADES
================================================================================

Upgrades are modular. Example (CAT 777):

    Engine:      Standard, High Efficiency, High Power
    Body:        Standard, Coal, High Capacity
    Tires:       Standard, Heavy Duty, Extreme Traction
    Electronics: Standard, Monitoring, Advanced Monitoring
    Automation:  None, Assisted, Autonomous

Upgrades modify actual simulation properties. Example: HIGH CAPACITY BODY:
+ payload, + cycle efficiency, - acceleration, + fuel consumption

================================================================================
9. EQUIPMENT WEAR AND MAINTENANCE
================================================================================

Condition: 100% New, 80% Good, 60% Used, 40% Worn, 20% Critical, 0% Failed

Wear is influenced by: operating hours, load, terrain, weather, operator skill,
maintenance quality

Maintenance types: PREVENTIVE, SCHEDULED, CORRECTIVE, EMERGENCY

Failures should be deterministic from simulation conditions with a controlled
random component. Avoid purely random "machine exploded" events.

================================================================================
10. WORKFORCE SYSTEM
================================================================================

Employees are persistent simulation entities.

Employee: id, name, age, role, skillLevel, experience, safetyRating,
productivity, reliability, fatigue, morale, wage, certifications,
assignedEquipment, employmentStatus

10.1 EMPLOYEE ROLES: Equipment Operator, Drill Operator, Blaster, Mechanic,
Electrician, Plant Operator, Conveyor Technician, Surveyor, Environmental
Technician, Safety Manager, Foreman, Supervisor, Dispatcher, Truck Driver

10.2 SKILLS: equipmentOperation, safety, maintenance, mining, driving, drilling,
blasting, leadership, plantOperation. Skill influences productivity, equipment
wear, safety, task duration, task quality.

10.3 FATIGUE increases with hours worked, overtime, difficult conditions, night
shifts; decreases with rest, days off, shift changes; influences productivity,
reaction time, safety risk, error probability.

================================================================================
11. DISPATCH SYSTEM
================================================================================

Two modes: MANUAL and AUTOMATIC.

MANUAL: Player selects equipment -> task -> source -> destination -> operator ->
Assign

AUTOMATIC: Player creates a production objective, e.g. "Remove 50,000 tons of
overburden." Dispatch AI determines required excavators, trucks, operators,
routes, task queue, priority.

11.1 DISPATCH PRIORITY: EMERGENCY, CRITICAL, HIGH, NORMAL, LOW

11.2 DISPATCH OBJECTIVES: REMOVE_OVERBURDEN, MINE_COAL, FEED_PLANT,
BUILD_STOCKPILE, MAINTAIN_ROAD, DRAIN_PIT

================================================================================
12. GEOLOGICAL MODEL
================================================================================

The geological world is represented as volumetric or layered data. Each region
contains: elevation, materialType, rockHardness, coalDepth, coalThickness,
coalQuality, moisture, density.

Material types: SOIL, TOPSOIL, SHALE, SANDSTONE, LIMESTONE, HARD_ROCK, COAL,
REFUSE

12.1 COAL SEAM: id, name, depth, thickness, quality, sulfur, ash, moisture,
estimatedReserve, recoverableReserve, discovered, confidence

12.2 GEOLOGICAL UNCERTAINTY: before exploration UNKNOWN; after drilling
ESTIMATED; after multiple samples HIGH_CONFIDENCE. The player should never
receive perfect geological information at the beginning of a scenario.

================================================================================
13. EXPLORATION SYSTEM
================================================================================

Select area -> Create exploration plan -> Assign drill -> Drill sample ->
Analyze sample -> Update geological model

Drill results: depth, seam thickness, coal quality, rock layers. The geological
map is gradually revealed.

================================================================================
14. TERRAIN SYSTEM
================================================================================

Terrain is divided into Forge-Engine terrain chunks. Each chunk stores elevation
data, material data, vegetation state, disturbance state, water state.

Mining operations can modify terrain: excavation, grading, spoil placement, road
construction, pit development, reclamation.

14.1 TERRAIN OPERATIONS: REMOVE_MATERIAL, ADD_MATERIAL, GRADE, COMPACT,
RESTORE_TOPSOIL, VEGETATE. Terrain modification should update collision,
navigation, visual mesh, material map, drainage, geological exposure.

14.2 PERFORMANCE: Terrain deformation must be simulation-driven but
rendering-aware. DO NOT regenerate the entire world mesh after every shovel
action. Use dirty chunks, queued terrain updates, LOD, chunk rebuild scheduling,
background processing where supported.

================================================================================
15. MINE BENCH SYSTEM
================================================================================

Bench: id, elevation, width, length, material, volume, miningState, accessRoad,
activeEquipment

Bench states: UNMINED, PREPARING, DRILLING, BLAST_READY, BLASTED, EXCAVATING,
COMPLETE, RECLAIMING, RECLAIMED

================================================================================
16. DRILLING SYSTEM
================================================================================

Player selects a bench. System generates a drill pattern. The player can
configure hole spacing, burden, hole depth, pattern, number of holes. The game
calculates estimated rock volume, drilling time, cost, expected fragmentation.

Drilling produces physical hole entities only where useful for visualization.
The simulation should store the drill pattern as data rather than requiring
thousands of heavyweight entities.

================================================================================
17. BLASTING SYSTEM
================================================================================

Blast: id, bench, blastArea, holeCount, blastDesign, estimatedMaterialMoved,
fragmentation, vibrationRisk, airblastRisk, flyrockRisk, approvalState,
executionState

Blast states: PLANNED, REVIEW, APPROVED, READY, EXECUTING, COMPLETED, FAILED

The player should interact with a simplified blast-planning interface. The game
simulates fragmentation, material displacement, digging difficulty, vibration,
airblast, flyrock risk, coal damage.

The blast system is NOT intended to provide real-world explosive engineering
instructions.

================================================================================
18. OVERBURDEN SYSTEM
================================================================================

After blasting, BLASTED_MATERIAL becomes available for excavation. Material
properties: volume, mass, fragmentation, hardness, location.

Excavation: BLASTED_OVERBURDEN -> LOADED_OVERBURDEN
Hauling:    LOADED_OVERBURDEN -> HAULED_OVERBURDEN
Dumping:    HAULED_OVERBURDEN -> SPOIL_MATERIAL

================================================================================
19. COAL EXTRACTION
================================================================================

Coal extraction begins when the coal seam is exposed:
EXPOSE -> CLEAN -> LOAD -> HAUL -> CRUSH -> PROCESS -> STOCKPILE -> SELL

Coal loss should be simulated. Example: geological coal 100,000 tons; mining
recovery 92%; processing recovery 88%; saleable coal 80,960 tons.

================================================================================
20. MATERIAL SYSTEM
================================================================================

Material is a first-class simulation concept. Material: id, type, mass, volume,
quality, moisture, composition, location, source, destination.

Material types: OVERBURDEN, COAL_RAW, COAL_CLEAN, REFUSE, TOPSOIL, SPOIL

Material must be transferable between equipment, stockpiles, conveyors, plants,
terrain.

================================================================================
21. HAULING SYSTEM
================================================================================

A haul cycle: EMPTY_TRAVEL -> POSITION -> LOAD -> LOADED_TRAVEL -> DUMP -> RETURN

Cycle time is determined by distance, grade, speed, payload, road condition,
operator skill, weather, equipment condition.

Production: tons_per_cycle * cycles_per_hour * utilization = tons_per_hour

================================================================================
22. HAUL ROAD SYSTEM
================================================================================

Road: id, path, width, grade, condition, speedLimit

Road conditions: EXCELLENT, GOOD, FAIR, POOR, DAMAGED, CLOSED

Weather can degrade roads. Equipment can also damage roads. Graders and water
trucks can maintain roads.

================================================================================
23. CONVEYOR SYSTEM
================================================================================

Construction workflow: Select conveyor -> Draw path -> Validate terrain ->
Calculate length -> Calculate elevation -> Calculate cost -> Build

Conveyor properties: length, capacity, speed, powerConsumption, condition,
incline, direction

Conveyor states: OFFLINE, STARTING, RUNNING, JAMMED, MAINTENANCE, DAMAGED

A conveyor network forms a directed logistics graph.

================================================================================
24. STOCKPILE SYSTEM
================================================================================

Stockpile: capacity, currentMass, materialType, quality, moisture, inputRate,
outputRate. Stockpiles can be RAW_COAL, CLEAN_COAL, REFUSE, OVERBURDEN.

Stockpile overflow should be a real operational problem.

================================================================================
25. PREPARATION PLANT
================================================================================

FEEDER -> CRUSHER -> SCREEN -> SEPARATOR -> (REFUSE | CLEAN COAL) -> STOCKPILE

Plant properties: throughput, efficiency, recovery, operatingCost,
powerConsumption, condition

Processing converts RAW_COAL -> CLEAN_COAL + REFUSE

================================================================================
26. ECONOMY SYSTEM
================================================================================

Treasury: cash, income, expenses, debt, credit

Expenses: payroll, fuel, maintenance, electricity, land, royalties, permits,
contractors, reclamation, loans

Income: coal sales, contracts, asset sales

The player should receive daily, weekly and monthly reports.

================================================================================
27. COAL MARKET
================================================================================

Coal customers have demand, quality requirements, volume, price, contract
duration. Examples: POWER_PLANT $63/ton 100,000 tons; INDUSTRIAL_CUSTOMER $78/ton
60,000 tons; PREMIUM_CUSTOMER $92/ton 40,000 tons.

Market prices should fluctuate but remain controllable for scenario design.

================================================================================
28. LAND / PROPERTY SYSTEM
================================================================================

Map parcels contain: parcelId, surfaceOwner, mineralOwner, surfaceRights,
mineralRights, leaseStatus, purchasePrice, leasePrice, royalty, accessRights,
easements

Parcel states: UNKNOWN, OWNED, AVAILABLE, NEGOTIATING, LEASED, RESTRICTED

================================================================================
29. LAND NEGOTIATION
================================================================================

Landowners are simulation characters. Their willingness to sell/lease depends on
price, royalties, relationship, mine reputation, property value, expected coal
value, personal circumstances.

Negotiation outcomes: ACCEPT, COUNTEROFFER, REFUSE, DELAY

================================================================================
30. PERMIT SYSTEM
================================================================================

Permit: id, type, applicationDate, approvalDate, expirationDate, status,
conditions, affectedParcels, affectedOperations

Permit states: NOT_REQUIRED, REQUIRED, APPLICATION, UNDER_REVIEW, APPROVED,
CONDITIONALLY_APPROVED, DENIED, EXPIRED, SUSPENDED, REVOKED

Permit categories: EXPLORATION, LAND_DISTURBANCE, SURFACE_MINING, BLASTING,
PROCESSING, CONVEYOR, WATER, ROAD, EXPANSION, RECLAMATION

================================================================================
31. REGULATORY SYSTEM
================================================================================

The regulatory system continuously evaluates mine conditions. Compliance areas:
equipment, safety, records, worker qualifications, blasting, roads, conveyors,
environmental conditions, reclamation.

The system should be rule-driven. Example: Rule ConveyorGuardRequired;
Condition conveyor.operating == true AND guard.condition != COMPLIANT; Result
potential violation.

================================================================================
32. MSHA INSPECTION SYSTEM
================================================================================

Inspectors are AI-controlled regulatory agents. Inspection can be scheduled,
routine, triggered, follow-up, special.

Inspection factors: mine history, safety record, previous violations, recent
incidents, operating conditions, random inspection probability.

ARRIVAL -> DOCUMENT_REVIEW -> SITE_INSPECTION -> EQUIPMENT_INSPECTION ->
WORKER_CHECK -> RECORD_REVIEW -> FINDINGS -> CITATIONS -> CORRECTIVE_ACTION

================================================================================
33. VIOLATION SYSTEM
================================================================================

Violation: id, category, severity, location, discoveredAt, description,
correctiveAction, deadline, fine, shutdownRisk

Severity: MINOR, MODERATE, SERIOUS, CRITICAL, IMMINENT_DANGER

Possible outcomes: warning, citation, fine, corrective action, equipment
shutdown, area shutdown, production suspension

================================================================================
34. SAFETY SYSTEM
================================================================================

Safety is calculated from actual operating conditions. Inputs: equipment
condition, worker fatigue, worker skill, road condition, weather, visibility,
maintenance, training, procedures, mine layout, operating speed.

Output: risk score. Risk categories: LOW, MODERATE, HIGH, CRITICAL.

The player should be able to inspect WHY risk is high.

================================================================================
35. WORKER CERTIFICATION SYSTEM
================================================================================

Some tasks require certifications. Example: Task BLAST requires
BLASTER_CERTIFICATION. Worker certified? YES -> continue; NO -> BLOCK.

Certifications can expire. Training can renew certifications.

================================================================================
36. ACCIDENT SYSTEM
================================================================================

Accidents should be caused by simulation conditions. Potential contributors:
equipment failure, fatigue, poor maintenance, unsafe behavior, weather, road
conditions, visibility, procedural failures.

Accident outcomes: equipment damage, production loss, worker injury,
investigation, regulatory action, financial loss, reputation damage.

Accidents should generate detailed incident reports.

================================================================================
37. ENVIRONMENT SYSTEM
================================================================================

Environmental state: landDisturbance, waterQuality, sediment, runoff, dust,
vegetation, reclamationProgress. Interacts with weather, mining, roads, spoil
piles, ponds, reclamation.

================================================================================
38. WATER SYSTEM
================================================================================

Water objects: drainageChannel, sedimentPond, settlingPond, pump,
treatmentSystem. Rainfall produces runoff, influenced by terrain, disturbed
land, vegetation, roads, pit geometry. Water can trigger flooding, pond
overflow, pumping requirements, environmental violations.

================================================================================
39. RECLAMATION SYSTEM
================================================================================

ACTIVE_MINING -> BACKFILL -> GRADE -> TOPSOIL -> SEED -> VEGETATION -> RECLAIMED

Reclamation consumes equipment time, workers, money, material. Reclamation
should reduce environmental disturbance and reclamation liability.

================================================================================
40. WEATHER SYSTEM
================================================================================

Weather states: SUNNY, CLOUDY, RAIN, HEAVY_RAIN, SNOW, ICE, FOG, WIND

Weather affects visibility, equipment productivity, haul roads, water, blasting
conditions, worker safety, equipment wear.

Weather should be deterministic enough for debugging while allowing controlled
randomness.

================================================================================
41. STORY SYSTEM
================================================================================

Campaign premise: The player inherits their grandfather's small surface coal
mine.

Initial conditions: old equipment, existing permits, limited cash, existing
workers, existing leases, outstanding obligations, known coal reserves,
incomplete infrastructure.

Key characters: Grandfather, Mine Foreman, Mechanic, Neighboring Landowners,
Bank Manager, Inspector, Major Customer, Competitor

================================================================================
42. CAMPAIGN STRUCTURE
================================================================================

CHAPTER 1 The Inheritance · CHAPTER 2 Keep the Mine Open · CHAPTER 3 The
Neighbor · CHAPTER 4 The Seam · CHAPTER 5 Expansion · CHAPTER 6 Regulatory
Pressure · CHAPTER 7 The Accident · CHAPTER 8 The Big Contract · CHAPTER 9 The
Big Seam · CHAPTER 10 Legacy

Story objectives must interact with simulation state. Never completely separate
missions from the actual mine simulation.

================================================================================
43. EVENT SYSTEM
================================================================================

Events can be generated by simulation conditions, story, economy, weather,
regulatory state, equipment, workforce.

Event: id, type, timestamp, severity, title, description, conditions, choices,
consequences

Examples: EQUIPMENT_FAILURE, LANDOWNER_DISPUTE, COAL_PRICE_CHANGE, HEAVY_RAIN,
INSPECTION, WORKER_SHORTAGE, CUSTOMER_REQUEST, CONTRACT_OPPORTUNITY, ROAD_FAILURE

================================================================================
44. PLAYER UI
================================================================================

Main HUD:

    +----------------------------------------------------------+
    | BLACK CREEK MINE                     DAY 184             |
    | $2,481,200       +$38,420/day                            |
    +----------------------------------------------------------+
    | COAL: 42,481 t      PRODUCTION: 3,240 t/day             |
    | RESERVES: 1.82M t   SAFETY: 91%                         |
    +----------------------------------------------------------+
    |                     MINE MAP                             |
    +----------------------------------------------------------+
    | MINE | EQUIPMENT | WORKERS | TASKS | LAND | PERMITS    |
    | FINANCE | PLANT | SAFETY | REPORTS | SETTINGS           |
    +----------------------------------------------------------+

================================================================================
45. EQUIPMENT INTERACTION
================================================================================

Clicking equipment opens the EQUIPMENT PANEL (e.g. CAT 777 #04 — Condition 82%,
Fuel 74%, Hours 8,241, Operator John Miller, Task Haul Overburden, Destination
Spoil Pile #01).

Available commands: ASSIGN TASK, CHANGE OPERATOR, FUEL, MAINTENANCE, REPAIR,
UPGRADE, PARK, INSPECT

================================================================================
46. TASK CREATION UI
================================================================================

Selecting ASSIGN TASK opens CREATE TASK: Type, Source, Destination, Operator,
Priority, [CANCEL] [ASSIGN].

The UI should show validation errors before assignment.

================================================================================
47. MAP OVERLAYS
================================================================================

NORMAL, GEOLOGY, OWNERSHIP, MINING, ELEVATION, SAFETY, EQUIPMENT, HAUL_ROADS,
WATER, PERMITS, RECLAMATION, CONVEYORS

Each overlay is a visualization layer rather than a separate world.

================================================================================
48. CAMERA SYSTEM
================================================================================

Camera modes: FREE_CAMERA, ISOMETRIC, FOLLOW_EQUIPMENT, FOLLOW_TASK, OVERVIEW

Camera controls: pan, orbit, zoom, rotate

Selecting an equipment entity should provide CENTER_CAMERA, FOLLOW, INSPECT.

================================================================================
49. NAVIGATION SYSTEM
================================================================================

Equipment navigation should operate over a dynamic navigation graph. Navigation
nodes: road nodes, pit ramps, loading areas, dumping areas, plant entrances,
maintenance areas.

Terrain changes can invalidate routes. Equipment must be able to respond to road
closure, pit expansion, blocked conveyor, flooding, construction.

================================================================================
50. AI ARCHITECTURE
================================================================================

AI should be layered: TASK AI -> ROLE AI -> EQUIPMENT AI -> MOVEMENT AI

Example: Task HAUL COAL; Role AI determines appropriate operator; Equipment AI
executes haul cycle; Movement AI navigates route.

The equipment itself should NOT contain business logic such as "I need to mine
coal." It should only execute commands.

================================================================================
51. SIMULATION VS PRESENTATION
================================================================================

CRITICAL ARCHITECTURAL RULE: SIMULATION STATE != VISUAL STATE

Simulation: Truck #04, position = (100, 200), payload = 82 tons, state = HAULING

Presentation: 3D truck model, animation, wheel rotation, dust, engine sound,
lights

The simulation remains authoritative. The renderer visualizes it.

================================================================================
52. DATA-DRIVEN EQUIPMENT
================================================================================

Equipment specifications should NOT be hardcoded into equipment classes. Use
data definitions, e.g. equipment/cat_777.json containing name, category, payload,
speed, fuelCapacity, purchasePrice, maintenance, requiredRole, upgrades.

This allows new equipment to be added without modifying simulation code.

================================================================================
53. DATA-DRIVEN GAME CONTENT
================================================================================

Use data files for equipment, employees, materials, geological definitions,
permits, violations, upgrades, contracts, customers, missions, events,
scenarios. The engine code provides behavior. Data provides content.

================================================================================
54. SCENARIO SYSTEM
================================================================================

A scenario defines map, geology, parcels, initial equipment, employees, permits,
finances, contracts, story, difficulty.

Example scenario_small_family_mine — Cash $750,000; Equipment 1 excavator,
2 trucks, 1 drill, 1 dozer; Employees 8; Coal reserve 1.2M tons; Land 120 acres.

================================================================================
55. SAVE GAME ARCHITECTURE
================================================================================

SaveGame: metadata (saveName, timestamp, gameVersion, scenarioId), worldState,
terrainState, geologyState, parcelState, equipmentState, workforceState,
taskState, materialState, logisticsState, processingState, permitState,
regulatoryState, financialState, environmentState, storyState

The save format must support version migration.

================================================================================
56. DEBUG SYSTEM
================================================================================

Forge-Engine debug tools should expose: FPS, simulation tick, entity count,
active tasks, equipment count, worker count, material quantities, terrain
chunks, pathfinding state, memory, task queues.

Developer commands: spawn equipment, spawn worker, create coal seam, create
blast, complete permit, trigger inspection, set weather, add money, damage
equipment, advance time, reveal geology.

These tools must only be available in developer/debug mode.

================================================================================
57. TELEMETRY / REPORTING
================================================================================

Daily: tons mined, tons processed, tons sold, equipment utilization, fuel
consumed, downtime, worker hours, incidents, violations, revenue, expenses.

Long-term: cost/ton, production/employee, equipment utilization, recovery rate,
safety performance, profitability.

These statistics power the management screens.

================================================================================
58. PERFORMANCE ARCHITECTURE
================================================================================

The mine may eventually contain hundreds of equipment entities, hundreds of
workers, thousands of tasks, large terrain areas, many material records.
Therefore DO NOT simulate everything at maximum detail. Use simulation tiers:

TIER 1 - PLAYER VICINITY: movement, animation, physics, visual effects, detailed AI
TIER 2 - ACTIVE MINE: movement, tasks, production, equipment
TIER 3 - DISTANT MINE AREAS: aggregate movement, task progress, production
TIER 4 - OFF-SCREEN: statistical production, fuel, wear, task completion

================================================================================
59. ENTITY LIFETIME
================================================================================

Avoid creating permanent entities for every transient operation. Individual coal
fragments: NO. Every grain of spoil: NO. Every drill hole: OPTIONAL / VISUAL
ONLY. Every truck, excavator, conveyor, stockpile: YES.

Material should generally be represented as quantities rather than individual
physical particles.

================================================================================
60. AUDIO SYSTEM
================================================================================

Equipment should generate contextual audio: excavator engine, diesel idle, truck
acceleration, hydraulic systems, conveyor motor, crusher, alarms, backup alarms,
drilling, blasting. Audio intensity should depend on distance, equipment load,
operating state.

================================================================================
61. VISUAL EFFECTS
================================================================================

Important effects: dust, smoke, exhaust, sparks, water spray, rain, mud, blast
dust, rock displacement, conveyor material, crusher material. Effects must remain
presentation-layer features.

================================================================================
62. LIGHTING / DAY-NIGHT
================================================================================

The world has a simulation clock. Lighting changes with time, weather, season.
Mine operations continue through night if lighting exists, workers are
scheduled, equipment is permitted to operate. Night operations should introduce
additional operational considerations.

================================================================================
63. CONSTRUCTION SYSTEM
================================================================================

Construction is data-driven. Construction object: type, footprint, cost,
buildTime, prerequisites, workerRequirements.

Constructible: road, conveyor, shop, office, plant, pond, fuel station, power
infrastructure, stockpile. Construction itself should generate tasks.

================================================================================
64. POWER SYSTEM
================================================================================

Electrical infrastructure: utilityConnection, generator, substation, powerLine,
transformer. Consumers: plant, conveyors, buildings, lighting, pumps. If
available power < demand: systems may throttle, equipment may stop, plant
throughput decreases.

================================================================================
65. PRODUCTION OBJECTIVES
================================================================================

Instead of manually assigning every task forever, players can create objectives,
e.g. Remove 50,000 tons of Overburden from Bench 04 to Spoil Area B. Dispatch
converts this into tasks.

Other objectives: Produce 5,000 tons/day, Maintain stockpile at 20,000 tons, Feed
plant continuously, Maintain road condition, Reclaim Bench 01.

================================================================================
66. MANAGEMENT LEVELS
================================================================================

The game should gradually transition from MICRO MANAGEMENT (early game: player
assigns individual trucks) to OPERATIONAL MANAGEMENT (late game: player assigns
production objectives). The player can still drill down to individual machines
whenever desired.

================================================================================
67. DIFFICULTY
================================================================================

Difficulty should modify starting capital, geology uncertainty, equipment
reliability, coal prices, permit complexity, regulatory scrutiny, worker
availability, weather, land prices. Do NOT simply increase enemy-style
difficulty numbers.

================================================================================
68. CAMPAIGN PROGRESSION
================================================================================

START: Equipment, Workers, Basic mining, Basic economy
THEN: Exploration, Drilling, Blasting, Land acquisition
THEN: Conveyors, Preparation plant, Contracts
THEN: Advanced equipment, Automation, Large-scale operations
THEN: Advanced regulatory, Reclamation, Regional expansion

================================================================================
69. FIRST VERTICAL SLICE
================================================================================

The first complete playable slice MUST contain only: One small map, One coal
seam, One land parcel, One excavator, Two haul trucks, One drill, One dozer, One
worker type, Basic task system, Drilling, Blasting, Overburden removal, Coal
exposure, Coal extraction, Coal hauling, Simple coal sale.

Player workflow: START GAME -> Inspect terrain -> Drill -> Discover coal seam ->
Prepare blast -> Blast -> Remove overburden -> Expose coal -> Mine coal -> Haul
coal -> Sell coal -> BUY MORE EQUIPMENT

This is the minimum viable mining game.

================================================================================
70. DEVELOPMENT PHASES
================================================================================

01 Forge-Engine integration, Game bootstrap, Simulation clock, Scene management,
   Selection, Camera, UI, Save/load
02 Mine world, Terrain, Terrain chunks, Roads, Basic environment, Map boundaries
03 Geology, Coal seams, Overburden, Material system, Exploration, Drilling
04 Equipment, Vehicles, Movement, Equipment state, Fuel, Wear, Maintenance
05 Workforce, Employees, Skills, Hiring, Operators, Fatigue
06 Task architecture, Task queue, Task dependencies, Task assignment, Dispatch,
   AI execution
07 Mining, Benches, Blasting, Overburden, Coal exposure, Coal extraction
08 Logistics, Haul roads, Stockpiles, Conveyors, Material routing
09 Preparation plant, Crusher, Screens, Processing, Clean coal, Refuse, Loadout
10 Economy, Coal market, Contracts, Payroll, Fuel, Maintenance, Loans, Royalties
11 Land, Parcels, Landowners, Mineral rights, Surface rights, Negotiation,
   Expansion
12 Permits, Permit applications, Permit conditions, Compliance, Reclamation bonds
13 Safety, Worker certifications, Inspections, Violations, Accidents, MSHA system
14 Environment, Water, Sediment, Dust, Reclamation, Weather
15 Campaign, Story, Characters, Missions, Events, Progression
16 Advanced mining, Draglines, Highwall mining, Surface miners, Automation,
   Large-scale logistics
17 Polish, Audio, VFX, Animations, UI, Tutorial, Optimization

================================================================================
71. IMPLEMENTATION PRIORITY
================================================================================

1 TASK SYSTEM · 2 EQUIPMENT + MOVEMENT · 3 TERRAIN + MATERIAL · 4 GEOLOGY + MINING
· 5 WORKFORCE · 6 LOGISTICS · 7 ECONOMY · 8 REGULATION · 9 STORY · 10 POLISH

REASON: The task system is the backbone of the entire game. If tasks are designed
correctly, the following become implementations of the same underlying
architecture: haul truck, excavator, drill, conveyor, plant, maintenance,
reclamation, inspection, construction.

================================================================================
72. CORE DOMAIN CLASSES
================================================================================

WORLD: MineWorld, TerrainChunk, GeologicalModel, GeologicalLayer, CoalSeam,
MiningBench, Parcel, Road, WaterBody
MINING: MiningOperation, DrillProgram, DrillHolePattern, Blast,
ExcavationOperation, ReclamationOperation
EQUIPMENT: EquipmentDefinition, EquipmentInstance, EquipmentController,
EquipmentUpgrade, MaintenanceJob
WORKFORCE: Employee, EmployeeSkill, Certification, TrainingProgram, Shift
TASKS: Task, TaskQueue, TaskAssignment, TaskDependency, DispatchPlan
LOGISTICS: HaulRoute, Conveyor, ConveyorNetwork, Stockpile, MaterialTransfer
PROCESSING: ProcessingPlant, ProcessingUnit, Crusher, Separator, Loadout
REGULATORY: Permit, PermitCondition, Inspection, Violation, ComplianceRule
ECONOMY: Treasury, Transaction, Contract, Loan, CoalMarket, Customer
ENVIRONMENT: WaterSystem, SedimentPond, ReclamationArea, WeatherState
STORY: Character, StoryChapter, Mission, GameEvent

================================================================================
73. CORE SERVICES
================================================================================

SimulationService, TaskService, DispatchService, EquipmentService,
WorkforceService, MiningService, GeologyService, TerrainService,
MaterialService, LogisticsService, ProcessingService, EconomyService,
PermitService, RegulatoryService, SafetyService, EnvironmentService,
StoryService, SaveGameService

Services should communicate through domain events where practical.

================================================================================
74. DOMAIN EVENTS
================================================================================

EquipmentSelected, TaskCreated, TaskAssigned, TaskStarted, TaskBlocked,
TaskCompleted, DrillStarted, DrillCompleted, BlastPrepared, BlastExecuted,
BlastCompleted, MaterialLoaded, MaterialMoved, MaterialDumped, CoalExposed,
CoalExtracted, EquipmentBreakdown, EquipmentRepaired, WorkerHired,
WorkerAssigned, WorkerFatigued, PermitSubmitted, PermitApproved, PermitDenied,
InspectionStarted, ViolationIssued, AccidentOccurred, ContractSigned, CoalSold,
ReclamationStarted, ReclamationCompleted

================================================================================
75. EVENT-DRIVEN COMMUNICATION
================================================================================

EquipmentBreakdown -> TaskService (block current task), DispatchService (find
replacement), EconomyService (create repair expense), UI (notification).

This prevents systems from becoming tightly coupled.

================================================================================
76. TESTING STRATEGY
================================================================================

Every simulation subsystem should have deterministic tests:

- "Truck hauling 100 tons over a 1 km road should arrive with approximately
  100 tons."
- "Equipment with zero condition cannot receive production tasks."
- "Worker without required certification cannot execute restricted task."
- "Invalid permit blocks restricted mining operation."
- "Conveyor cannot exceed throughput capacity."
- "Processing plant converts raw coal into clean coal according to configured
  recovery."
- "Reclamation reduces disturbance."

================================================================================
77. DEBUG SCENARIOS
================================================================================

SCENARIO_01_BASIC_HAUL (excavator, truck, material, road)
SCENARIO_02_BLAST (bench, drill, blast, overburden)
SCENARIO_03_COAL (exposed coal, excavator, trucks, stockpile)
SCENARIO_04_CONVEYOR (stockpile, conveyor, plant)
SCENARIO_05_INSPECTION (intentionally invalid mine, inspector, violations)
SCENARIO_06_ECONOMY (coal, customer, expenses, revenue)

These scenarios allow systems to be tested independently of the campaign.

================================================================================
78. DEVELOPMENT TOOLING
================================================================================

In-game developer panel: WORLD (reveal geology, terrain tools, weather),
EQUIPMENT (spawn, damage, repair, refuel), WORKERS (spawn, skill, fatigue,
certification), TASKS (create, complete, cancel, block), ECONOMY (add cash,
modify coal price, create contract), REGULATION (trigger inspection, create
violation, approve permit), TIME (advance hour, advance day, advance month).

================================================================================
79. CONTENT PIPELINE
================================================================================

New equipment should require: equipment definition, 3D model, textures, audio,
optional animations, upgrade definitions, worker requirements.

New mine scenario should require: terrain, geological configuration, parcels,
initial state, equipment, workers, permits, finances, story configuration.

The goal is to add content without changing core simulation code.

================================================================================
80. MODULARITY
================================================================================

The architecture should eventually allow new equipment, mines, scenarios,
geological configurations, customers, contracts, missions, equipment upgrades
without modifying the underlying simulation systems.

================================================================================
81. LONG-TERM FEATURES
================================================================================

Multiple mines, Regional map, Competitor mines, Rail transportation, Barges, Coal
export terminals, Advanced geological exploration, Dragline operations, Highwall
mining, Underground mine transition, Autonomous fleets, Advanced preparation
plants, Corporate management, Multiple mine ownership, Acquisitions, Mergers,
Financial markets, Multiplayer / cooperative management

================================================================================
82. FINAL ARCHITECTURAL PRINCIPLE
================================================================================

THE MINE IS A SIMULATION. Not a collection of buildings. Not a collection of
vehicle animations. Not a tycoon UI with a 3D background.

The 3D world is the visualization of the simulation. The simulation is
authoritative. The player interacts with the simulation through WORLD ->
EQUIPMENT -> TASKS -> WORKFORCE -> PRODUCTION -> LOGISTICS -> ECONOMY ->
REGULATION -> EXPANSION.

================================================================================
83. TARGET GAMEPLAY LOOP
================================================================================

INHERIT MINE -> INSPECT OPERATION -> REVIEW GEOLOGY -> ACQUIRE LAND -> OBTAIN
PERMITS -> PLAN MINING AREA -> CLEAR LAND -> DRILL -> BLAST -> REMOVE OVERBURDEN
-> EXPOSE COAL -> MINE COAL -> HAUL COAL -> PROCESS COAL -> STOCKPILE -> SELL
COAL -> PROFIT -> BUY EQUIPMENT -> HIRE WORKERS -> BUILD INFRASTRUCTURE ->
EXPAND MINE (loop) -> RECLAIM MINED LAND -> GROW THE OPERATION

================================================================================
84. SUCCESS CRITERIA
================================================================================

The game prototype is considered successful when the player can:

[ ] Load a mine                 [ ] Inspect terrain          [ ] Discover geology
[ ] Drill                       [ ] Create a blast           [ ] Execute a blast
[ ] Remove overburden           [ ] Expose coal              [ ] Mine coal
[ ] Assign operators            [ ] Move haul trucks         [ ] Haul material
[ ] Build a haul road           [ ] Build a conveyor         [ ] Process coal
[ ] Sell coal                   [ ] Buy equipment            [ ] Upgrade equipment
[ ] Hire employees              [ ] Maintain equipment       [ ] Acquire land
[ ] Obtain permits              [ ] Receive an inspection    [ ] Receive violations
[ ] Correct violations          [ ] Manage finances          [ ] Reclaim land
[ ] Save and load the mine      [ ] Complete the grandfather campaign

================================================================================
85. FIRST IMPLEMENTATION TARGET
================================================================================

DO NOT BEGIN BY BUILDING: MSHA, Story, Financial markets, Multiple mines,
Advanced preparation plants, Multiplayer, Draglines, Complex UI

BEGIN WITH: FORGE ENGINE + GAME STATE + SIMULATION CLOCK + TERRAIN + MATERIAL +
EQUIPMENT + WORKER + TASK + NAVIGATION + EXCAVATION

The first milestone should produce: A small 3D mine. An excavator. Two haul
trucks. One drill. A coal seam. A spoil pile. A worker.

The player selects the excavator. The player assigns "REMOVE OVERBURDEN". The
excavator performs the task. The player assigns a truck. The truck drives to the
excavator. The excavator loads it. The truck drives to the spoil pile. The truck
dumps. The terrain changes. The coal seam becomes exposed. The player can then
mine the coal.

THIS IS THE FOUNDATION OF THE ENTIRE GAME.
```
